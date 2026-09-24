// broker.mjs — the multiplexing rules, with no sockets or processes in sight so
// the tests can drive it message by message. The daemon wires it to the real
// backend's stdio and to one socket per Claude Code session.
//
// LSP assumes one client per server. What has to be rewritten so N sessions can
// share one typescript-language-server:
//   * request ids      — every session numbers from 0; the backend sees one global
//                        sequence and responses are mapped back.
//   * initialize       — sent once; later sessions get the cached result.
//   * open documents   — refcounted; the backend gets one didOpen/didClose per uri
//                        and one monotonic version sequence per uri.
//   * diagnostics      — only to sessions that have that document open.
//   * shutdown / exit  — one session leaving must not stop the shared server.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const REQUEST_CANCELLED = -32800;

const idKey = (id) => JSON.stringify(id);

// One document, however it is spelled. typescript-language-server answers
// `file:///D:/x.ts` with diagnostics for `file:///d%3A/x.ts`, so matching the
// strings drops every diagnostic on Windows. Compare the file path instead,
// case-folded where the file system is.
export function docKey(uri) {
  try {
    const p = fileURLToPath(uri);
    return process.platform === "win32" ? p.toLowerCase() : p;
  } catch {
    return String(uri);
  }
}

function readDisk(uri) {
  try { return fs.readFileSync(fileURLToPath(uri), "utf8"); } catch { return undefined; }
}

// The text a didChange leaves behind, when the change carries it. Mixed or ranged
// edits return undefined: applying them needs the base this session last saw.
function wholeText(changes) {
  if (!Array.isArray(changes) || changes.length === 0) return undefined;
  if (!changes.every((c) => c && c.range === undefined && typeof c.text === "string")) return undefined;
  return changes[changes.length - 1].text;
}

export class Broker {
  #toBackend;
  #log;
  #pid;
  #memoryOverride;
  #memoryDefault;
  #onEmpty;
  #onInitFailed;

  #clients = new Set();
  #primary = null;
  #nextClient = 1;
  #nextGid = 0;
  #nextServerRequest = 0;
  #pending = new Map();        // backend id -> { client, clientId, isInit }
  #serverRequests = new Map(); // id we gave a session -> { backendId, client }
  #init = { state: "none", result: null, error: null, queue: [], initializedSent: false };
  #docs = new Map();           // docKey -> { uri, openers: Set<client>, text: string | undefined }
  #versions = new Map();       // docKey -> last version the backend saw; never reset

  constructor({
    toBackend,
    log = () => {},
    processId = process.pid,
    memoryOverride,
    memoryDefault,
    onEmpty = () => {},
    onInitFailed = () => {},
  }) {
    this.#toBackend = toBackend;
    this.#log = log;
    this.#pid = processId;
    this.#memoryOverride = memoryOverride;
    this.#memoryDefault = memoryDefault;
    this.#onEmpty = onEmpty;
    this.#onInitFailed = onInitFailed;
  }

  get clientCount() { return this.#clients.size; }
  get openDocumentCount() { return this.#docs.size; }

  // `send` delivers one message to the session; `close` drops its transport.
  addClient(send, close = () => {}) {
    // `opened` holds docKeys; `idMap` maps the session's request ids to ours.
    const client = { id: this.#nextClient++, send, close, alive: true, opened: new Set(), idMap: new Map() };
    this.#clients.add(client);
    if (!this.#primary) this.#primary = client;
    return client;
  }

  removeClient(client) {
    if (!client.alive) return;
    client.alive = false;
    this.#clients.delete(client);
    for (const key of client.opened) this.#release(client, key);
    client.opened.clear();
    // Its in-flight work is nobody's now. The initialize stays: its answer is
    // cached for the next session even if the one that asked has gone.
    for (const [gid, entry] of this.#pending) {
      if (entry.client !== client || entry.isInit) continue;
      this.#pending.delete(gid);
      this.#toBackend({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: gid } });
    }
    for (const [muxId, entry] of this.#serverRequests) {
      if (entry.client !== client) continue;
      this.#serverRequests.delete(muxId);
      this.#toBackend({ jsonrpc: "2.0", id: entry.backendId, error: { code: REQUEST_CANCELLED, message: "session left before answering" } });
    }
    if (this.#primary === client) this.#primary = this.#clients.values().next().value ?? null;
    this.#log("session", client.id, "left;", this.#clients.size, "remain");
    if (this.#clients.size === 0) this.#onEmpty();
  }

  fromClient(client, msg) {
    if (!client.alive || !msg || typeof msg !== "object") return;

    // A session answering something the backend asked it.
    if (msg.method === undefined) {
      const entry = msg.id !== undefined ? this.#serverRequests.get(msg.id) : undefined;
      if (entry) {
        this.#serverRequests.delete(msg.id);
        this.#toBackend({ ...msg, id: entry.backendId });
      }
      return;
    }

    switch (msg.method) {
      case "initialize": return this.#initialize(client, msg);
      case "initialized":
        if (this.#init.state === "done" && !this.#init.initializedSent) {
          this.#init.initializedSent = true;
          this.#toBackend(msg);
        }
        return;
      case "shutdown":
        client.send({ jsonrpc: "2.0", id: msg.id, result: null });
        return;
      case "exit":
        this.removeClient(client);
        client.close();
        return;
      case "textDocument/didOpen": return this.#didOpen(client, msg);
      case "textDocument/didChange": return this.#didChange(client, msg);
      case "textDocument/didClose": {
        const key = docKey(msg.params?.textDocument?.uri);
        if (!client.opened.delete(key)) return;
        this.#release(client, key);
        return;
      }
      case "$/cancelRequest": {
        const gid = client.idMap.get(idKey(msg.params?.id));
        if (gid !== undefined) this.#toBackend({ ...msg, params: { ...msg.params, id: gid } });
        return;
      }
    }

    if (msg.id !== undefined) {
      const gid = this.#track(client, msg.id, false);
      this.#toBackend({ ...msg, id: gid });
      return;
    }
    this.#toBackend(msg);
  }

  fromBackend(msg) {
    if (!msg || typeof msg !== "object") return;

    if (msg.method === undefined) {
      const entry = this.#pending.get(msg.id);
      if (!entry) return;
      this.#pending.delete(msg.id);
      entry.client.idMap.delete(idKey(entry.clientId));
      if (entry.isInit) this.#settleInit(msg);
      if (entry.client.alive) entry.client.send({ ...msg, id: entry.clientId });
      return;
    }

    if (msg.id !== undefined) {
      const target = this.#primary;
      if (!target) {
        this.#toBackend({ jsonrpc: "2.0", id: msg.id, error: { code: REQUEST_CANCELLED, message: "no session attached" } });
        return;
      }
      const muxId = `tsd:${this.#nextServerRequest++}`;
      this.#serverRequests.set(muxId, { backendId: msg.id, client: target });
      target.send({ ...msg, id: muxId });
      return;
    }

    if (msg.method === "textDocument/publishDiagnostics") {
      const doc = this.#docs.get(docKey(msg.params?.uri));
      // Nobody has it open any more: whatever this says is stale, and pushing it
      // to the other sessions would put another session's file in their context.
      if (!doc) return;
      // A version, if the backend ever sends one, is in our numbering, not theirs.
      const { version: _version, ...params } = msg.params;
      for (const c of doc.openers) c.send({ ...msg, params });
      return;
    }

    for (const c of this.#clients) c.send(msg);
  }

  #initialize(client, msg) {
    const init = this.#init;
    if (init.state === "done") return client.send({ jsonrpc: "2.0", id: msg.id, result: init.result });
    if (init.state === "failed") return client.send({ jsonrpc: "2.0", id: msg.id, error: init.error });
    if (init.state === "pending") { init.queue.push({ client, id: msg.id }); return; }

    init.state = "pending";
    const params = msg.params ?? {};
    const options = params.initializationOptions ?? {};
    const gid = this.#track(client, msg.id, true);
    this.#toBackend({
      ...msg,
      id: gid,
      params: {
        ...params,
        // The backend exits when `processId` dies. Given the first session's pid it
        // would take LSP down for every attached session when that one closed, so
        // it watches the daemon; each shim watches its own session instead.
        processId: this.#pid,
        initializationOptions: {
          ...options,
          // One tsserver now holds every project the sessions touch, so the V8
          // default (~4 GB) is too small, and no cap at all is how a single
          // instance reached 61.5 GB in anthropics/claude-code#87301.
          maxTsServerMemory: this.#memoryOverride ?? options.maxTsServerMemory ?? this.#memoryDefault,
        },
      },
    });
  }

  #settleInit(msg) {
    const init = this.#init;
    const queue = init.queue.splice(0);
    if (msg.error) {
      init.state = "failed";
      init.error = msg.error;
      for (const q of queue) if (q.client.alive) q.client.send({ jsonrpc: "2.0", id: q.id, error: msg.error });
      this.#log("initialize failed:", msg.error?.message ?? "unknown");
      this.#onInitFailed(msg.error);
      return;
    }
    init.state = "done";
    init.result = msg.result ?? null;
    for (const q of queue) if (q.client.alive) q.client.send({ jsonrpc: "2.0", id: q.id, result: init.result });
  }

  #didOpen(client, msg) {
    const td = msg.params?.textDocument;
    if (!td?.uri) return;
    const key = docKey(td.uri);
    const text = typeof td.text === "string" ? td.text : "";
    client.opened.add(key);
    const doc = this.#docs.get(key);
    if (!doc) {
      // The backend keeps the first spelling of the uri for as long as it is open.
      this.#docs.set(key, { uri: td.uri, openers: new Set([client]), text });
      this.#toBackend({ ...msg, params: { ...msg.params, textDocument: { ...td, version: this.#bump(key) } } });
      return;
    }
    doc.openers.add(client);
    // Open already for another session. This one read the file later, so its
    // copy is the fresher view of disk — and pushing it even when unchanged is
    // what makes the backend publish diagnostics this session has never seen.
    this.#pushText(key, doc, text);
  }

  #didChange(client, msg) {
    const key = docKey(msg.params?.textDocument?.uri);
    const doc = client.opened.has(key) ? this.#docs.get(key) : undefined;
    if (!doc) return;
    // A ranged edit is relative to what *this* session last saw, which another
    // session may have moved on since. Claude Code writes the file before it
    // reports the change, so disk is the copy every session agrees on.
    const text = wholeText(msg.params.contentChanges) ?? readDisk(doc.uri);
    if (text === undefined) {
      doc.text = undefined;
      this.#toBackend({ ...msg, params: { ...msg.params, textDocument: { uri: doc.uri, version: this.#bump(key) } } });
      return;
    }
    // Pushed even when another session already sent this exact text: this
    // session made an edit and is owed fresh diagnostics for it.
    this.#pushText(key, doc, text);
  }

  #pushText(key, doc, text) {
    doc.text = text;
    this.#toBackend({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: { textDocument: { uri: doc.uri, version: this.#bump(key) }, contentChanges: [{ text }] },
    });
  }

  #release(client, key) {
    const doc = this.#docs.get(key);
    if (!doc) return;
    doc.openers.delete(client);
    if (doc.openers.size > 0) return;
    this.#docs.delete(key);
    this.#toBackend({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri: doc.uri } } });
  }

  #bump(key) {
    const v = (this.#versions.get(key) ?? 0) + 1;
    this.#versions.set(key, v);
    return v;
  }

  #track(client, clientId, isInit) {
    const gid = this.#nextGid++;
    this.#pending.set(gid, { client, clientId, isInit });
    client.idMap.set(idKey(clientId), gid);
    return gid;
  }
}
