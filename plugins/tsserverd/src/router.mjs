// router.mjs — one Claude Code session in front of several project servers.
//
// Claude Code starts one language server per session and hands it every TS/JS
// file the session touches, from any repo. The router sends each file to the
// link of the project it belongs to (see project.mjs):
//   * document messages and document requests → by the file's project;
//   * requests about a call/type hierarchy item → by the item's file;
//   * workspace/symbol → every connected project, results merged;
//   * anything else with an id → the project used last;
//   * other notifications → every connected project.
// It answers `initialize` itself (capabilities.mjs) and never forwards the
// session's shutdown/exit: projects are released separately (tick) or when the
// session ends (close).
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { docKey } from "./broker.mjs";
import { idKey } from "./link.mjs";

function pathOf(uri) {
  try { return fileURLToPath(uri); } catch { return null; }
}

function readDisk(uri) {
  try { return fs.readFileSync(fileURLToPath(uri), "utf8"); } catch { return undefined; }
}

function wholeText(changes) {
  if (!Array.isArray(changes) || changes.length === 0) return undefined;
  if (!changes.every((c) => c && c.range === undefined && typeof c.text === "string")) return undefined;
  return changes[changes.length - 1].text;
}

// The file a request is about, when it names one.
function uriOf(params) {
  if (!params || typeof params !== "object") return undefined;
  if (params.textDocument?.uri) return params.textDocument.uri;
  if (params.item?.uri) return params.item.uri;
  if (typeof params.data?.file === "string") return pathToFileURL(params.data.file).href;
  if (typeof params.data?.uri === "string") return params.data.uri;
  return undefined;
}

export class Router {
  session = null; // the session's initialize params

  #toClient;
  #projectForFile;
  #makeLink;
  #capabilities;
  #log;
  #onExit;
  #idleMs;

  #links = new Map();          // project key → link
  #docs = new Map();           // docKey → { uri, languageId, version, text, link }
  #fanouts = new Map();        // idKey → { id, waiting: Set<link>, results, errors }
  #serverRequests = new Map(); // our id → { link, id }
  #nextServerRequest = 0;
  #last = null;

  constructor({ toClient, projectForFile, makeLink, capabilities, log = () => {}, onExit = () => {}, projectIdleMs }) {
    this.#toClient = toClient;
    this.#projectForFile = projectForFile;
    this.#makeLink = makeLink;
    this.#capabilities = capabilities;
    this.#log = log;
    this.#onExit = onExit;
    this.#idleMs = projectIdleMs;
  }

  get links() { return [...this.#links.values()]; }

  fromClient(msg) {
    if (!msg || typeof msg !== "object") return;

    // The session answering something a project server asked it.
    if (msg.method === undefined) {
      const entry = this.#serverRequests.get(msg.id);
      if (!entry) return;
      this.#serverRequests.delete(msg.id);
      // Only the connection that asked gets the answer: after a release or a
      // crash the link's new server may have reused the same id for another question.
      if (entry.link.state === "ready" && entry.link.generation === entry.generation) entry.link.send({ ...msg, id: entry.id });
      return;
    }

    switch (msg.method) {
      case "initialize": return this.#initialize(msg);
      case "initialized": return;
      case "shutdown": this.#toClient({ jsonrpc: "2.0", id: msg.id, result: null }); return;
      case "exit": this.close(); this.#onExit(0); return;
      case "textDocument/didOpen": return this.#didOpen(msg);
      case "textDocument/didChange": return this.#didChange(msg);
      case "textDocument/didClose":
      case "textDocument/didSave": return this.#toOpenDoc(msg);
      case "$/cancelRequest": return this.#cancel(msg);
      case "workspace/symbol": return this.#fanOut(msg);
    }

    if (msg.id !== undefined) {
      const link = this.#linkForUri(uriOf(msg.params)) ?? this.#last;
      if (!link) { this.#toClient({ jsonrpc: "2.0", id: msg.id, result: null }); return; }
      link.send(msg);
      return;
    }
    for (const link of this.#links.values()) if (link.state === "ready") link.send(msg);
  }

  fromLink(link, msg) {
    if (msg.method === undefined) {
      const fan = this.#fanouts.get(idKey(msg.id));
      if (fan?.waiting.has(link)) { this.#collect(fan, link, msg); return; }
      this.#toClient(msg);
      return;
    }
    if (msg.id !== undefined) {
      // Ids from different servers collide; the session gets one of ours.
      const ours = `tsd:${this.#nextServerRequest++}`;
      this.#serverRequests.set(ours, { link, id: msg.id, generation: link.generation });
      this.#toClient({ ...msg, id: ours });
      return;
    }
    if (msg.method === "$/cancelRequest") {
      for (const [ours, entry] of this.#serverRequests) {
        if (entry.link !== link || idKey(entry.id) !== idKey(msg.params?.id)) continue;
        this.#toClient({ ...msg, params: { ...msg.params, id: ours } });
      }
      return;
    }
    this.#toClient(msg);
  }

  // Documents the session has open in `link`'s project, for re-opening after a
  // release or a restart.
  docsOf(link) {
    return [...this.#docs.values()].filter((d) => d.link === link);
  }

  // Let projects nobody has used for a while go; their daemons then exit and
  // take their tsservers with them.
  tick(now = Date.now()) {
    for (const link of this.#links.values()) {
      if (link.state === "ready" && link.inflight.size === 0 && now - link.lastUsed > this.#idleMs) link.release();
    }
  }

  close() {
    for (const link of this.#links.values()) link.close();
  }

  #initialize(msg) {
    this.session = msg.params ?? {};
    Promise.resolve()
      .then(() => this.#capabilities(this.session))
      .then(
        (result) => this.#toClient({ jsonrpc: "2.0", id: msg.id, result }),
        (e) => this.#toClient({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e?.message ?? String(e) } }),
      );
  }

  #linkForUri(uri) {
    const file = uri ? pathOf(uri) : null;
    if (!file) return null;
    const project = this.#projectForFile(file);
    // The global TypeScript's own lib files: whichever project led the session
    // there can answer about them; starting a server for them would not.
    if (project.library && this.#last) return this.#last;
    let link = this.#links.get(project.key);
    if (!link) {
      link = this.#makeLink(project, {
        onMessage: (l, m) => this.fromLink(l, m),
        reopen: (l) => this.docsOf(l),
      });
      this.#links.set(project.key, link);
      this.#log("routing", project.root, `(${project.source} TypeScript)`);
    }
    this.#last = link;
    return link;
  }

  #didOpen(msg) {
    const td = msg.params?.textDocument;
    const key = docKey(td?.uri);
    const open = this.#docs.get(key);
    if (open) {
      // Opened again without a close. A shared daemon would cope, but a private
      // typescript-language-server throws "Can't open already open document"
      // and keeps the old text; as an edit, with a version that only goes up,
      // both take it.
      open.text = td.text ?? "";
      open.version = Math.max((open.version ?? 0) + 1, td.version ?? 0);
      this.#last = open.link;
      open.link.send({
        jsonrpc: "2.0",
        method: "textDocument/didChange",
        params: { textDocument: { uri: open.uri, version: open.version }, contentChanges: [{ text: open.text }] },
      });
      return;
    }
    const link = this.#linkForUri(td?.uri);
    if (!link) return;
    this.#docs.set(key, { uri: td.uri, languageId: td.languageId, version: td.version, text: td.text ?? "", link });
    link.send(msg);
  }

  #didChange(msg) {
    const td = msg.params?.textDocument;
    const doc = this.#docs.get(docKey(td?.uri));
    if (!doc) return;
    // Kept current so the file can be re-opened if its server is released.
    const text = wholeText(msg.params.contentChanges) ?? readDisk(doc.uri);
    if (text !== undefined) doc.text = text;
    if (td.version !== undefined) doc.version = td.version;
    this.#last = doc.link;
    doc.link.send(msg);
  }

  // didClose/didSave only mean something to a server that has the file open:
  // one released meanwhile must not be woken up to hear it.
  #toOpenDoc(msg) {
    const key = docKey(msg.params?.textDocument?.uri);
    const doc = this.#docs.get(key);
    if (!doc) return;
    if (msg.method === "textDocument/didClose") this.#docs.delete(key);
    if (doc.link.state === "ready" || doc.link.state === "connecting") doc.link.send(msg);
  }

  #cancel(msg) {
    const id = msg.params?.id;
    const fan = this.#fanouts.get(idKey(id));
    const targets = fan ? [...fan.waiting] : this.links.filter((l) => l.has(id));
    for (const link of targets) link.send(msg);
  }

  #fanOut(msg) {
    // Connecting links count: the project being worked on is often the one
    // still starting, and a queued request is always answered or refused.
    const targets = new Set(this.links.filter((l) => l.state === "ready" || l.state === "connecting"));
    if (this.#last) targets.add(this.#last);
    if (targets.size === 0) { this.#toClient({ jsonrpc: "2.0", id: msg.id, result: [] }); return; }
    const fan = { id: msg.id, waiting: new Set(targets), results: [], errors: [] };
    this.#fanouts.set(idKey(msg.id), fan);
    for (const link of targets) link.send(msg);
  }

  #collect(fan, link, msg) {
    fan.waiting.delete(link);
    if (msg.error) fan.errors.push(msg.error);
    else if (Array.isArray(msg.result)) fan.results.push(...msg.result);
    if (fan.waiting.size > 0) return;
    this.#fanouts.delete(idKey(fan.id));
    if (fan.results.length === 0 && fan.errors.length > 0) this.#toClient({ jsonrpc: "2.0", id: fan.id, error: fan.errors[0] });
    else this.#toClient({ jsonrpc: "2.0", id: fan.id, result: fan.results });
  }
}
