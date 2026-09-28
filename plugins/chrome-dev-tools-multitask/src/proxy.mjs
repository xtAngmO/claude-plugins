// proxy.mjs — stands in for chrome-devtools-mcp until a browser is needed.
//
// Claude Code starts every MCP server with every session and asks it for its
// tools straight away. Most sessions never open a browser, yet each one kept a
// chrome-devtools-mcp alive (three node processes, ~260 MB of private memory).
// This proxy answers `initialize` and `tools/list` from what the real server
// said the last time, and only starts it (and claims a Chrome slot) for a call
// that needs it. When nothing has used the browser for a while, the server is
// stopped, which closes Chrome and frees the slot; the next call starts it
// again on the same project's profile, so sign-ins survive.
//
// MCP over stdio is one JSON message per line. The two sides number their own
// requests, and a message with an id and no method is an answer, so answers
// are routed by direction and need no renumbering.

export const HANDSHAKE_ID = "cdp-mt:init";
const LEVEL_ID = "cdp-mt:level";
const idKey = (id) => JSON.stringify(id);

// The browser runs hidden (headless) by default so a session's work never
// pops a window over what the user is doing. This tool, answered by the proxy
// itself, is the way back to a window when a person has to see or touch the
// page. Headless Chrome defaults to an 800x600 viewport, which responsive
// pages lay out as a tablet, so hidden browsers get a desktop-sized one.
export const VISIBILITY_TOOL = {
  name: "set_browser_visible",
  description:
    "Show or hide the Chrome window this session drives. The browser runs hidden (headless) by default so it never interrupts the user. " +
    "Make it visible when the user has to see or use the page themselves: to sign in (2FA, SSO), solve a captcha, or watch what happens; hide it again afterwards. " +
    "Switching restarts the browser on the same profile: sign-ins and cookies are kept, but open pages are closed, so navigate again afterwards.",
  inputSchema: {
    type: "object",
    properties: { visible: { type: "boolean", description: "true opens the browser in a normal window; false runs it hidden again." } },
    required: ["visible"],
    additionalProperties: false,
  },
  annotations: { title: "Show or hide the browser", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const HIDDEN_VIEWPORT = "1280x800";

// Hidden or visible is the proxy's to switch (set_browser_visible), so a
// headless flag among the pass-through ones only sets the starting mode: left
// in, it would pin the mode and make set_browser_visible(true) a lie.
const HEADLESS_FLAG = /^--(no-)?headless(=.*)?$/;
export function splitHeadless(args, fallback) {
  let headless = fallback;
  const rest = [];
  for (const a of args) {
    const m = HEADLESS_FLAG.exec(a);
    if (!m) { rest.push(a); continue; }
    headless = !m[1] && !/^=(false|0)$/i.test(m[2] ?? "");
  }
  return { headless, rest };
}

const withOwnTool = (result) =>
  result?.nextCursor ? result : { ...result, tools: [...(result?.tools ?? []).filter((t) => t.name !== VISIBILITY_TOOL.name), VISIBILITY_TOOL] };
const textResult = (text) => ({ content: [{ type: "text", text }] });

export class Proxy {
  #toClient;
  #startServer;
  #slots;
  #cache;
  #log;
  #killBrowsers;
  #idleMs;
  #lazy;
  #extraArgs;
  #cacheScope;
  #now;
  #headless;

  #clientInit = null;      // the client's initialize params, replayed to every server we start
  #clientInitialized = false;
  #logLevel = null;        // logging/setLevel answered locally, replayed on start
  #server = null;
  #state = "stopped";      // stopped → starting → ready
  #handshakeId = null;
  #serverInitialized = false;
  #queue = [];             // client traffic waiting for the server to be ready
  #pending = new Map();    // client requests the server still owes an answer
  #toolsListIds = new Set();
  #claimed = null;         // { slot, profile } while a server runs
  #stopping = null;        // a stop still closing its browser and freeing its slot
  #startTimer = null;
  #startTimeoutMs;
  #lastActivity = 0;

  constructor({ toClient, startServer, slots, cache, log = () => {}, killBrowsers = () => {}, idleMs = 30 * 60 * 1000, lazy = true, extraArgs = [], cacheScope = "", now = () => Date.now(), headless = true, startTimeoutMs = 120_000 }) {
    ({ headless: this.#headless, rest: this.#extraArgs } = splitHeadless(extraArgs, headless));
    this.#toClient = toClient;
    this.#startServer = startServer;
    this.#slots = slots;
    this.#cache = cache;
    this.#log = log;
    this.#killBrowsers = killBrowsers;
    this.#idleMs = idleMs;
    this.#lazy = lazy;
    this.#cacheScope = cacheScope;
    this.#now = now;
    this.#startTimeoutMs = startTimeoutMs;
  }

  get state() { return this.#state; }
  get slot() { return this.#claimed?.slot ?? null; }

  fromClient(msg) {
    if (!msg || typeof msg !== "object") return;

    // The client answering a request the server made.
    if (msg.method === undefined) {
      if (this.#state !== "stopped") this.#toServer(msg);
      return;
    }

    switch (msg.method) {
      case "initialize": return this.#initialize(msg);
      case "notifications/initialized":
        this.#clientInitialized = true;
        if (this.#state === "ready" && !this.#serverInitialized) this.#sendInitialized();
        return;
      // Answered here unless a server is up: a health check must not wait out a
      // first-time download. The level is replayed once a server is ready.
      case "ping":
        if (this.#state !== "ready") { this.#reply(msg.id, {}); return; }
        break;
      case "logging/setLevel":
        this.#logLevel = msg.params ?? null;
        if (this.#state !== "ready") { this.#reply(msg.id, {}); return; }
        break;
      case "notifications/cancelled": {
        // The server never answers a request it was told to cancel, so it must
        // stop counting as owed (or the browser is never idle again). One still
        // queued is simply not sent: the click the user cancelled never happens.
        const key = idKey(msg.params?.requestId);
        const at = this.#queue.findIndex((m) => m.method !== undefined && m.id !== undefined && idKey(m.id) === key);
        if (at >= 0) { this.#queue.splice(at, 1); return; }
        this.#pending.delete(key);
        break;
      }
      case "tools/list": {
        const cached = this.#state === "stopped" && !msg.params?.cursor ? this.#cache.get("tools", this.#key()) : null;
        if (cached) { this.#reply(msg.id, withOwnTool(cached)); return; }
        if (!msg.params?.cursor) this.#toolsListIds.add(idKey(msg.id));
        break;
      }
      case "tools/call":
        if (msg.params?.name === VISIBILITY_TOOL.name) { this.#setVisible(msg); return; }
        break;
    }

    if (msg.id !== undefined) {
      this.#lastActivity = this.#now();
      this.#toServer(msg);
      return;
    }
    // A notification for a server that is not running has nobody to tell.
    if (this.#state !== "stopped") this.#toServer(msg);
  }

  // Stop a server nothing has used for idleMs.
  async tick() {
    if (!this.#idleMs || this.#state !== "ready" || this.#pending.size || this.#queue.length) return;
    if (this.#now() - this.#lastActivity < this.#idleMs) return;
    this.#log(`no browser use for ${Math.round(this.#idleMs / 60000)} min; closing it`);
    await this.#stop();
  }

  async close() {
    if (this.#state !== "stopped") await this.#stop();
    await this.#stopping;
  }

  #key() {
    return `${this.#cacheScope}|${this.#clientInit?.protocolVersion ?? ""}`;
  }

  #setVisible(msg) {
    const visible = msg.params?.arguments?.visible === true;
    const where = visible ? "in a normal window the user can see" : "hidden, in the background";
    if (visible === !this.#headless) {
      this.#reply(msg.id, textResult(`The browser already runs ${where}.`));
      return;
    }
    this.#headless = !visible;
    this.#log(`browser switched to ${visible ? "visible" : "hidden"}`);
    if (this.#state === "stopped") {
      this.#reply(msg.id, textResult(`The browser will run ${where} from the next browser action.`));
      return;
    }
    // A running browser cannot change mode: restart it on the same profile.
    // Calls still queued behind a start were never sent, so they carry over to
    // the new browser instead of failing.
    this.#lastActivity = this.#now();
    this.#stop("chrome-devtools-mcp was restarted to switch windows", { keepQueue: true }).then(() => {
      this.#reply(msg.id, textResult(
        `The browser now runs ${where}. It was restarted on the same profile: sign-ins and cookies are kept, ` +
        "but the pages that were open are gone. Open the page again with navigate_page or new_page.",
      ));
      if (this.#state === "stopped" && this.#queue.length) this.#start(null);
    });
  }

  #reply(id, result) {
    this.#toClient({ jsonrpc: "2.0", id, result });
  }

  #initialize(msg) {
    this.#clientInit = msg.params ?? {};
    const cached = this.#lazy ? this.#cache.get("init", this.#key()) : null;
    if (cached) { this.#reply(msg.id, cached); return; }
    // Nothing learned yet (first run, a new version, or lazy off): the real
    // server answers, and what it says is kept for every later session.
    this.#start(msg);
  }

  #toServer(msg) {
    if (this.#state === "ready") { this.#write(msg); return; }
    this.#queue.push(msg);
    if (this.#state === "stopped") this.#start(null);
  }

  #write(msg) {
    if (msg.method !== undefined && msg.id !== undefined) this.#pending.set(idKey(msg.id), msg.id);
    this.#server.write(msg);
  }

  #start(clientInitialize) {
    this.#state = "starting";
    this.#serverInitialized = false;
    // A server still on its way out holds its slot, and its browser may still
    // be open on that profile. Starting now could land on the same slot (the
    // lock is ours already), and the old stop's clean-up would then close the
    // new browser and free a slot that is in use. So wait for it; traffic
    // meanwhile queues, as for any start.
    if (this.#stopping) {
      this.#stopping.then(() => {
        if (this.#state === "starting" && !this.#server) this.#launch(clientInitialize);
      });
      return;
    }
    this.#launch(clientInitialize);
  }

  #launch(clientInitialize) {
    this.#claimed = this.#slots.claim();
    const profileArgs = this.#claimed ? [`--user-data-dir=${this.#claimed.profile}`] : ["--isolated=true"];
    if (!this.#claimed) this.#log("every slot is taken; this browser gets a throwaway profile");
    const hasViewport = this.#extraArgs.some((a) => a.startsWith("--viewport"));
    const modeArgs = this.#headless ? ["--headless", ...(hasViewport ? [] : [`--viewport=${HIDDEN_VIEWPORT}`])] : [];
    let server = null;
    server = this.#startServer({
      args: [...profileArgs, ...modeArgs, ...this.#extraArgs],
      onMessage: (m) => { if (server === this.#server) this.#fromServer(m); },
      onExit: (code) => { if (server === this.#server) this.#exited(code); },
    });
    this.#server = server;
    // A download that stalls or a server that never answers would otherwise
    // keep every call queued for ever.
    clearTimeout(this.#startTimer);
    this.#startTimer = setTimeout(() => {
      if (server !== this.#server || this.#state !== "starting") return;
      this.#log(`chrome-devtools-mcp did not start within ${Math.round(this.#startTimeoutMs / 1000)} s`);
      this.#stop("chrome-devtools-mcp did not start in time; try again");
    }, this.#startTimeoutMs);
    this.#startTimer.unref?.();
    const handshake = clientInitialize ?? { jsonrpc: "2.0", id: HANDSHAKE_ID, method: "initialize", params: this.#clientInit ?? {} };
    this.#handshakeId = handshake.id;
    server.write(handshake);
  }

  #fromServer(msg) {
    if (msg.method === undefined && msg.id !== undefined && idKey(msg.id) === idKey(this.#handshakeId)) {
      clearTimeout(this.#startTimer);
      if (msg.result) this.#cache.set("init", this.#key(), msg.result);
      if (this.#handshakeId !== HANDSHAKE_ID) this.#toClient(msg); // it was the client's own initialize
      if (msg.error) {
        this.#log(`server refused initialize: ${msg.error.message ?? ""}`);
        this.#handshakeId = null; // answered already; the teardown must not answer it again
        this.#stop();
        return;
      }
      this.#state = "ready";
      if (this.#clientInitialized) this.#sendInitialized();
      if (this.#logLevel) this.#server.write({ jsonrpc: "2.0", id: LEVEL_ID, method: "logging/setLevel", params: this.#logLevel });
      for (const queued of this.#queue.splice(0)) this.#write(queued);
      return;
    }
    if (msg.method === undefined && msg.id === LEVEL_ID) return;
    if (msg.method === undefined && msg.id !== undefined) {
      const key = idKey(msg.id);
      this.#pending.delete(key);
      if (this.#toolsListIds.delete(key) && msg.result) {
        // The server's own list is what gets remembered; the session sees ours added.
        if (!msg.result.nextCursor) this.#cache.set("tools", this.#key(), msg.result);
        this.#toClient({ ...msg, result: withOwnTool(msg.result) });
        return;
      }
    }
    this.#toClient(msg);
  }

  #sendInitialized() {
    this.#serverInitialized = true;
    this.#server.write({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  // The server went away on its own (crash, killed browser, bad version).
  // Its process is already gone, so the slot can be cleaned up right away.
  #exited(code) {
    this.#log(`chrome-devtools-mcp exited (${code ?? "signal"})`);
    const claimed = this.#teardown(`chrome-devtools-mcp stopped (exit ${code ?? "?"}); the next call starts it again`);
    this.#cleanUp(claimed);
  }

  // We stop it: wait until the process is gone (it closes its browser on the
  // way out), then clean up. A start requested meanwhile waits for all of it.
  // Stops chain: a second one must not let a start through while the first is
  // still cleaning up, or that clean-up would close the new browser.
  async #stop(reason = "chrome-devtools-mcp was stopped", { keepQueue = false } = {}) {
    const server = this.#server;
    const claimed = this.#teardown(reason, { keepQueue });
    const previous = this.#stopping;
    const exited = server?.stop();
    const done = (async () => {
      await previous;
      await exited;
      this.#cleanUp(claimed);
    })();
    this.#stopping = done;
    await done;
    if (this.#stopping === done) this.#stopping = null;
  }

  // Forget the server and answer everything it still owed. Returns the slot it
  // held; the caller cleans that up once the process is really gone.
  #teardown(reason, { keepQueue = false } = {}) {
    const wasStarting = this.#state === "starting";
    const handshakeWasClient = this.#handshakeId !== null && this.#handshakeId !== HANDSHAKE_ID;
    clearTimeout(this.#startTimer);
    this.#server = null;
    this.#state = "stopped";
    const fail = (id) => this.#toClient({ jsonrpc: "2.0", id, error: { code: -32603, message: reason } });
    for (const id of this.#pending.values()) fail(id);
    this.#pending.clear();
    const isRequest = (m) => m.method !== undefined && m.id !== undefined;
    const queued = this.#queue.splice(0);
    // Only requests carry over: answers and notifications were for this server.
    if (keepQueue) this.#queue.push(...queued.filter(isRequest));
    else for (const m of queued) if (isRequest(m)) fail(m.id);
    if (wasStarting && handshakeWasClient) fail(this.#handshakeId);
    this.#handshakeId = null;
    this.#toolsListIds.clear();
    const claimed = this.#claimed;
    this.#claimed = null;
    return claimed;
  }

  // Normally the server closes its browser; this is the backstop for one that
  // could not, so the slot's profile is free for the next browser.
  #cleanUp(claimed) {
    if (!claimed) return;
    // Only when a browser still holds the profile: the process query behind
    // the kill costs about a second, and a clean exit leaves nothing to kill.
    if (this.#slots.busy?.(claimed.profile) ?? true) this.#killBrowsers(claimed.profile);
    this.#slots.release(claimed.slot);
  }
}
