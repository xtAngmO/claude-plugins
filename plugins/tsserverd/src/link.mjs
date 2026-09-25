// link.mjs — one session's connection to one project's language server.
//
// Normally that is the project's daemon, shared with every other session. If no
// daemon answers, or one hangs up (or goes silent) before initialize is
// answered, the link runs a private typescript-language-server for the project
// for a while instead, so a broken daemon costs memory, never LSP.
//
// A link can be released while idle (to let the daemon, and its tsserver, go)
// and comes back on the next message: it re-initializes, then re-opens every
// document the session still has open in that project.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveBackend, spawnBackend } from "./backend.mjs";
import { docKey } from "./broker.mjs";
import { createReader, encode, endpointFor } from "./lib.mjs";

const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.mjs");
const CONNECT_WAIT_MS = 8000;
// typescript-language-server answers initialize before it loads any project,
// so a server silent this long is not coming back.
const INIT_TIMEOUT_MS = 60 * 1000;
// After a daemon lets us down, try it again after this long, not never.
const PRIVATE_FOR_MS = 5 * 60 * 1000;
const INIT_ID = "tsd:init";
const BYE_ID = "tsd:bye";
const REQUEST_FAILED = -32803;
// A project whose server keeps dying is left alone for a while instead of
// being restarted on every keystroke.
const FAILURE_WINDOW_MS = 2 * 60 * 1000;
const FAILURE_LIMIT = 3;
const FAILED_PAUSE_MS = 5 * 60 * 1000;

export const idKey = (id) => JSON.stringify(id);

const DOC_NOTIFICATIONS = new Set(["textDocument/didOpen", "textDocument/didChange", "textDocument/didClose", "textDocument/didSave"]);

function readDisk(uri) {
  try { return fs.readFileSync(fileURLToPath(uri), "utf8"); } catch { return undefined; }
}

function launchDaemon(project, args, log) {
  try {
    spawn(process.execPath, [DAEMON, "--launch", project.root, ...args], {
      detached: true, stdio: "ignore", windowsHide: true,
      // The daemon derives its endpoint from root + flavor; it must match ours.
      env: { ...process.env, TSD_DAEMON_FLAVOR: project.flavor ?? "" },
    }).unref();
    log("launched daemon for", project.root);
  } catch (e) {
    log("could not launch daemon:", e.message);
  }
}

function connectDaemon(project, args, log) {
  const endpoint = endpointFor(project.key);
  const since = Date.now();
  let launched = false;
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.connect(endpoint);
      sock.once("connect", () => { sock.removeAllListeners("error"); resolve(sock); });
      sock.once("error", () => {
        sock.destroy();
        if (!launched) { launched = true; launchDaemon(project, args, log); }
        if (Date.now() - since > CONNECT_WAIT_MS) { resolve(null); return; }
        setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function socketTransport(sock, onMessage, onClose) {
  sock.on("data", createReader(onMessage));
  sock.on("error", () => {});
  sock.on("close", onClose);
  return {
    kind: "shared",
    write: (msg) => { if (!sock.destroyed) sock.write(encode(msg)); },
    close: () => sock.end(),
  };
}

// The daemon's socket, or failing that a private server. Injected in tests.
async function openTransport({ project, args, log, usePrivate, onMessage, onClose }) {
  const sock = usePrivate ? null : await connectDaemon(project, args, log);
  if (sock) return socketTransport(sock, onMessage, onClose);
  const spec = resolveBackend(args);
  if (!spec) throw new Error("typescript-language-server is not installed");
  log("running a private server for", project.root);
  return privateTransport(spec, onMessage, onClose);
}

function privateTransport(spec, onMessage, onClose) {
  const child = spawnBackend(spec, { stdio: ["pipe", "pipe", "ignore"] });
  let closed = false;
  const done = () => { if (!closed) { closed = true; onClose(); } };
  child.on("exit", done);
  child.on("error", done);
  // spawn can hand back a child without pipes (EMFILE); that is a failed start.
  if (!child.stdout || !child.stdin) throw new Error("could not start typescript-language-server");
  child.stdout.on("data", createReader(onMessage));
  child.stdin.on("error", () => {});
  const write = (msg) => { if (child.stdin.writable) child.stdin.write(encode(msg)); };
  return {
    kind: "private",
    write,
    close: () => {
      write({ jsonrpc: "2.0", id: BYE_ID, method: "shutdown" });
      write({ jsonrpc: "2.0", method: "exit" });
      setTimeout(() => { try { child.kill(); } catch {} }, 1500).unref();
    },
  };
}

export class ProjectLink {
  state = "idle"; // idle → connecting → ready; failed while paused
  queue = [];
  inflight = new Map(); // idKey → the session's id, for requests written and not yet answered
  lastUsed = Date.now();
  // Bumped per connection, so an answer meant for an earlier server (before a
  // release or a crash) is recognised and dropped.
  generation = 0;

  #transport = null;
  #initAnswered = false;
  #initTimer = null;
  #privateUntil = 0;
  #failures = [];
  #pausedUntil = 0;
  #openTransport;
  #initTimeoutMs;

  // hooks: onMessage(link, msg) for everything the session should see;
  // reopen(link) → [{ uri, languageId, version, text }] the session has open here.
  constructor({ project, args, log, initParams, onMessage, reopen, transport = openTransport, initTimeoutMs = INIT_TIMEOUT_MS }) {
    this.project = project;
    this.args = args;
    this.log = log;
    this.initParams = initParams;
    this.onMessage = onMessage;
    this.reopen = reopen;
    this.#openTransport = transport;
    this.#initTimeoutMs = initTimeoutMs;
  }

  get kind() { return this.#transport?.kind ?? null; }

  send(msg) {
    this.lastUsed = Date.now();
    if (msg.method === "$/cancelRequest" && this.#dropQueued(msg.params?.id)) return;
    if (this.state === "ready") { this.#write(msg); return; }
    if (this.state === "failed") {
      if (Date.now() < this.#pausedUntil) { this.#refuse(msg, "the TypeScript server for this project keeps failing"); return; }
      this.state = "idle";
      this.#failures = [];
    }
    this.queue.push(msg);
    if (this.state === "idle") this.#start();
  }

  // Whether this link owes the session an answer for `id`, sent or still queued.
  has(id) {
    const key = idKey(id);
    return this.inflight.has(key) || this.queue.some((m) => m.method !== undefined && m.id !== undefined && idKey(m.id) === key);
  }

  // Let go while nothing is in flight; the next message brings the link back,
  // to the shared daemon again even if this connection was a private one.
  release() {
    if (this.state !== "ready" || this.inflight.size > 0) return false;
    const t = this.#transport;
    this.#transport = null;
    this.state = "idle";
    this.#privateUntil = 0;
    t.close();
    this.log("released", this.project.root);
    return true;
  }

  close() {
    const t = this.#transport;
    this.#transport = null;
    this.state = "idle";
    clearTimeout(this.#initTimer);
    t?.close();
  }

  // In flight means written: a request still in the queue is not owed by any
  // server yet, and failing it now would answer it twice once the queue runs.
  #write(msg) {
    if (msg.method !== undefined && msg.id !== undefined) this.inflight.set(idKey(msg.id), msg.id);
    this.#transport.write(msg);
  }

  #dropQueued(id) {
    const key = idKey(id);
    const at = this.queue.findIndex((m) => m.method !== undefined && m.id !== undefined && idKey(m.id) === key);
    if (at === -1) return false;
    const [msg] = this.queue.splice(at, 1);
    this.onMessage(this, { jsonrpc: "2.0", id: msg.id, error: { code: -32800, message: "cancelled" } });
    return true;
  }

  #start() {
    this.#open().catch((e) => this.#fail(e?.message ?? String(e)));
  }

  async #open() {
    this.state = "connecting";
    this.#initAnswered = false;
    const usePrivate = Date.now() < this.#privateUntil;
    let t = null;
    const onMessage = (msg) => { if (t && this.#transport === t) this.#fromBackend(msg); };
    const onClose = () => { if (t && this.#transport === t) this.#lost(); };
    t = await this.#openTransport({ project: this.project, args: this.args, log: this.log, usePrivate, onMessage, onClose });
    // Closed or released while we were connecting: nobody wants this one.
    if (this.state !== "connecting") { t.close(); return; }
    this.#transport = t;
    this.generation++;
    clearTimeout(this.#initTimer);
    this.#initTimer = setTimeout(() => {
      if (this.#transport !== t || this.#initAnswered) return;
      this.log("no answer to initialize from", this.project.root);
      this.#lost();
      t.close();
    }, this.#initTimeoutMs);
    this.#initTimer.unref?.();
    t.write({ jsonrpc: "2.0", id: INIT_ID, method: "initialize", params: this.initParams(this.project) });
  }

  #fromBackend(msg) {
    if (msg.id === INIT_ID && msg.method === undefined) {
      this.#initAnswered = true;
      clearTimeout(this.#initTimer);
      if (msg.error) { this.#fail(msg.error.message ?? "initialize failed"); return; }
      this.#ready();
      return;
    }
    if (msg.id === BYE_ID && msg.method === undefined) return;
    if (msg.method === undefined) this.inflight.delete(idKey(msg.id));
    this.onMessage(this, msg);
  }

  #ready() {
    const t = this.#transport;
    this.state = "ready";
    t.write({ jsonrpc: "2.0", method: "initialized", params: {} });
    // After a release or a restart the server has none of the session's files
    // open. Re-open them as they are now — from disk, which Claude Code writes
    // before it reports an edit and which Bash or git may have changed while the
    // project was released. The queued document traffic for those files is then
    // history: replaying an open, close or edit would contradict the re-open.
    const reopened = new Set();
    for (const doc of this.reopen(this)) {
      reopened.add(docKey(doc.uri));
      t.write({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version, text: readDisk(doc.uri) ?? doc.text } },
      });
    }
    for (const msg of this.queue.splice(0)) {
      if (DOC_NOTIFICATIONS.has(msg.method) && reopened.has(docKey(msg.params?.textDocument?.uri))) continue;
      this.#write(msg);
    }
  }

  #lost() {
    const kind = this.#transport?.kind;
    this.#transport = null;
    clearTimeout(this.#initTimer);
    if (this.state === "connecting" && kind === "shared" && !this.#initAnswered) {
      // The daemon hung up (or went silent) before initialize was answered: its
      // backend died on start, or it was idling out as we arrived. Nothing
      // reached the session yet, so the queue can go to a server of our own.
      this.log("daemon for", this.project.root, "did not answer initialize; going private for a while");
      this.#privateUntil = Date.now() + PRIVATE_FOR_MS;
      this.#start();
      return;
    }
    const now = Date.now();
    this.#failures = this.#failures.filter((at) => now - at < FAILURE_WINDOW_MS).concat(now);
    this.log("lost the server for", this.project.root, `(${this.#failures.length} in the last 2 min)`);
    this.#failInflight("the TypeScript server restarted; try again");
    if (this.#failures.length >= FAILURE_LIMIT) { this.#fail("the TypeScript server keeps exiting"); return; }
    // A private server that died gets the daemon another chance. The next
    // message re-opens the link; a queue waiting for this connection is retried now.
    if (kind === "private") this.#privateUntil = 0;
    this.state = "idle";
    if (this.queue.length) this.#start();
  }

  #fail(reason) {
    this.log("giving up on", this.project.root, "for 5 min:", reason);
    const t = this.#transport;
    this.#transport = null;
    clearTimeout(this.#initTimer);
    t?.close();
    this.state = "failed";
    this.#pausedUntil = Date.now() + FAILED_PAUSE_MS;
    for (const msg of this.queue.splice(0)) this.#refuse(msg, reason);
    this.#failInflight(reason);
  }

  #refuse(msg, reason) {
    if (msg.method === undefined || msg.id === undefined) return;
    this.onMessage(this, { jsonrpc: "2.0", id: msg.id, error: { code: REQUEST_FAILED, message: reason } });
  }

  #failInflight(reason) {
    const ids = [...this.inflight.values()];
    this.inflight.clear();
    for (const id of ids) this.onMessage(this, { jsonrpc: "2.0", id, error: { code: REQUEST_FAILED, message: reason } });
  }
}
