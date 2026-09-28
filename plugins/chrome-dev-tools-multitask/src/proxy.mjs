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
  #lastActivity = 0;

  constructor({ toClient, startServer, slots, cache, log = () => {}, killBrowsers = () => {}, idleMs = 30 * 60 * 1000, lazy = true, extraArgs = [], cacheScope = "", now = () => Date.now() }) {
    this.#toClient = toClient;
    this.#startServer = startServer;
    this.#slots = slots;
    this.#cache = cache;
    this.#log = log;
    this.#killBrowsers = killBrowsers;
    this.#idleMs = idleMs;
    this.#lazy = lazy;
    this.#extraArgs = extraArgs;
    this.#cacheScope = cacheScope;
    this.#now = now;
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
      case "ping":
        if (this.#state === "stopped") { this.#reply(msg.id, {}); return; }
        break;
      case "logging/setLevel":
        this.#logLevel = msg.params ?? null;
        if (this.#state === "stopped") { this.#reply(msg.id, {}); return; }
        break;
      case "tools/list": {
        const cached = this.#state === "stopped" && !msg.params?.cursor ? this.#cache.get("tools", this.#key()) : null;
        if (cached) { this.#reply(msg.id, cached); return; }
        if (!msg.params?.cursor) this.#toolsListIds.add(idKey(msg.id));
        break;
      }
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
  }

  #key() {
    return `${this.#cacheScope}|${this.#clientInit?.protocolVersion ?? ""}`;
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
    this.#claimed = this.#slots.claim();
    const profileArgs = this.#claimed ? [`--user-data-dir=${this.#claimed.profile}`] : ["--isolated=true"];
    if (!this.#claimed) this.#log("every slot is taken; this browser gets a throwaway profile");
    let server = null;
    server = this.#startServer({
      args: [...profileArgs, ...this.#extraArgs],
      onMessage: (m) => { if (server === this.#server) this.#fromServer(m); },
      onExit: (code) => { if (server === this.#server) this.#exited(code); },
    });
    this.#server = server;
    const handshake = clientInitialize ?? { jsonrpc: "2.0", id: HANDSHAKE_ID, method: "initialize", params: this.#clientInit ?? {} };
    this.#handshakeId = handshake.id;
    server.write(handshake);
  }

  #fromServer(msg) {
    if (msg.method === undefined && msg.id !== undefined && idKey(msg.id) === idKey(this.#handshakeId)) {
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
      if (this.#toolsListIds.delete(key) && msg.result && !msg.result.nextCursor) this.#cache.set("tools", this.#key(), msg.result);
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
  // way out), then clean up.
  async #stop() {
    const server = this.#server;
    const claimed = this.#teardown("chrome-devtools-mcp was stopped");
    await server?.stop();
    this.#cleanUp(claimed);
  }

  // Forget the server and answer everything it still owed. Returns the slot it
  // held; the caller cleans that up once the process is really gone.
  #teardown(reason) {
    const wasStarting = this.#state === "starting";
    const handshakeWasClient = this.#handshakeId !== null && this.#handshakeId !== HANDSHAKE_ID;
    this.#server = null;
    this.#state = "stopped";
    const fail = (id) => this.#toClient({ jsonrpc: "2.0", id, error: { code: -32603, message: reason } });
    for (const id of this.#pending.values()) fail(id);
    this.#pending.clear();
    for (const m of this.#queue.splice(0)) if (m.method !== undefined && m.id !== undefined) fail(m.id);
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
    this.#killBrowsers(claimed.profile);
    this.#slots.release(claimed.slot);
  }
}
