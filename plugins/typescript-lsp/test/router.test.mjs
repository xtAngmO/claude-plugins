import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Router } from "../src/router.mjs";

const BASE = path.join(os.tmpdir(), "tsd-router");
const fileIn = (project, name) => path.join(BASE, project, name);
const uriIn = (project, name) => pathToFileURL(fileIn(project, name)).href;

class FakeLink {
  constructor(project, hooks) {
    this.project = project;
    this.hooks = hooks;
    this.state = "ready";
    this.inflight = new Map();
    this.sent = [];
    this.lastUsed = Date.now();
    this.released = 0;
    this.closed = 0;
    this.generation = 1;
  }
  send(msg) {
    this.sent.push(msg);
    this.lastUsed = Date.now();
    if (msg.method !== undefined && msg.id !== undefined) this.inflight.set(JSON.stringify(msg.id), msg.id);
  }
  has(id) { return this.inflight.has(JSON.stringify(id)); }
  release() { this.released++; this.state = "idle"; return true; }
  close() { this.closed++; }
  // The server answering or asking something.
  emit(msg) {
    if (msg.method === undefined) this.inflight.delete(JSON.stringify(msg.id));
    this.hooks.onMessage(this, msg);
  }
}

function setup({ idleMs = 60000 } = {}) {
  const out = [];
  const links = {};
  let exited = null;
  const router = new Router({
    toClient: (m) => out.push(m),
    projectForFile: (file) => {
      const name = path.relative(BASE, file).split(path.sep)[0];
      return { key: name, root: path.join(BASE, name), source: "project", library: name === "globalts" };
    },
    makeLink: (project, hooks) => (links[project.key] = new FakeLink(project, hooks)),
    capabilities: async () => ({ capabilities: { hoverProvider: true } }),
    onExit: (code) => { exited = code; },
    projectIdleMs: idleMs,
  });
  return { router, out, links, exited: () => exited };
}

const open = (project, name, text = "x") => ({
  jsonrpc: "2.0", method: "textDocument/didOpen",
  params: { textDocument: { uri: uriIn(project, name), languageId: "typescript", version: 1, text } },
});
const hover = (id, project, name) => ({
  jsonrpc: "2.0", id, method: "textDocument/hover",
  params: { textDocument: { uri: uriIn(project, name) }, position: { line: 0, character: 0 } },
});

test("initialize is answered from capabilities, without starting any project", async () => {
  const { router, out, links } = setup();
  router.fromClient({ jsonrpc: "2.0", id: 0, method: "initialize", params: { processId: 1, capabilities: {} } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(out, [{ jsonrpc: "2.0", id: 0, result: { capabilities: { hoverProvider: true } } }]);
  assert.deepEqual(router.session, { processId: 1, capabilities: {} });
  assert.deepEqual(Object.keys(links), []);
});

test("each file goes to its own project's link, one link per project", () => {
  const { router, links } = setup();
  router.fromClient(open("web", "a.ts"));
  router.fromClient(open("web", "b.ts"));
  router.fromClient(open("api", "c.ts"));
  assert.deepEqual(Object.keys(links).sort(), ["api", "web"]);
  assert.equal(links.web.sent.length, 2);
  assert.equal(links.api.sent.length, 1);
  router.fromClient(hover(5, "api", "c.ts"));
  assert.equal(links.api.sent.at(-1).id, 5);
});

test("answers from a project reach the session unchanged", () => {
  const { router, out, links } = setup();
  router.fromClient(open("web", "a.ts"));
  router.fromClient(hover(7, "web", "a.ts"));
  links.web.emit({ jsonrpc: "2.0", id: 7, result: { contents: "number" } });
  assert.deepEqual(out.at(-1), { jsonrpc: "2.0", id: 7, result: { contents: "number" } });
});

test("a call hierarchy item is routed by the item's file", () => {
  const { router, links } = setup();
  router.fromClient(open("web", "a.ts"));
  router.fromClient(open("api", "c.ts"));
  router.fromClient({ jsonrpc: "2.0", id: 3, method: "callHierarchy/incomingCalls", params: { item: { uri: uriIn("web", "a.ts"), name: "f" } } });
  assert.equal(links.web.sent.at(-1).id, 3);
});

test("a request naming no file goes to the project used last, or gets null", () => {
  const { router, out, links } = setup();
  router.fromClient({ jsonrpc: "2.0", id: 1, method: "workspace/executeCommand", params: { command: "x" } });
  assert.deepEqual(out.at(-1), { jsonrpc: "2.0", id: 1, result: null });
  router.fromClient(open("web", "a.ts"));
  router.fromClient(open("api", "c.ts"));
  router.fromClient({ jsonrpc: "2.0", id: 2, method: "workspace/executeCommand", params: { command: "x" } });
  assert.equal(links.api.sent.at(-1).id, 2);
});

test("workspace/symbol asks every connected project and merges the answers", () => {
  const { router, out, links } = setup();
  router.fromClient(open("web", "a.ts"));
  router.fromClient(open("api", "c.ts"));
  router.fromClient({ jsonrpc: "2.0", id: 9, method: "workspace/symbol", params: { query: "f" } });
  links.web.emit({ jsonrpc: "2.0", id: 9, result: [{ name: "fromWeb" }] });
  assert.equal(out.length, 0, "waits for every project");
  links.api.emit({ jsonrpc: "2.0", id: 9, result: [{ name: "fromApi" }] });
  assert.deepEqual(out.at(-1), { jsonrpc: "2.0", id: 9, result: [{ name: "fromWeb" }, { name: "fromApi" }] });
});

test("workspace/symbol: one project failing still returns the others; all failing is an error", () => {
  const { router, out, links } = setup();
  router.fromClient(open("web", "a.ts"));
  router.fromClient(open("api", "c.ts"));
  router.fromClient({ jsonrpc: "2.0", id: 1, method: "workspace/symbol", params: { query: "f" } });
  links.web.emit({ jsonrpc: "2.0", id: 1, error: { code: -32803, message: "restarted" } });
  links.api.emit({ jsonrpc: "2.0", id: 1, result: [{ name: "fromApi" }] });
  assert.deepEqual(out.at(-1), { jsonrpc: "2.0", id: 1, result: [{ name: "fromApi" }] });

  router.fromClient({ jsonrpc: "2.0", id: 2, method: "workspace/symbol", params: { query: "f" } });
  links.web.emit({ jsonrpc: "2.0", id: 2, error: { code: -32803, message: "a" } });
  links.api.emit({ jsonrpc: "2.0", id: 2, error: { code: -32803, message: "b" } });
  assert.deepEqual(out.at(-1), { jsonrpc: "2.0", id: 2, error: { code: -32803, message: "a" } });
});

test("workspace/symbol includes a project that is still starting", () => {
  const { router, out, links } = setup();
  router.fromClient(open("web", "a.ts"));
  router.fromClient(open("api", "c.ts"));
  links.api.state = "connecting";
  router.fromClient({ jsonrpc: "2.0", id: 3, method: "workspace/symbol", params: { query: "f" } });
  assert.equal(links.api.sent.at(-1).id, 3, "asked the starting project too");
  links.web.emit({ jsonrpc: "2.0", id: 3, result: [] });
  links.api.emit({ jsonrpc: "2.0", id: 3, result: [{ name: "fromApi" }] });
  assert.deepEqual(out.at(-1), { jsonrpc: "2.0", id: 3, result: [{ name: "fromApi" }] });
});

test("opening an already-open file again becomes an edit with a version that only goes up", () => {
  const { router, links } = setup();
  router.fromClient(open("web", "a.ts", "v1"));
  router.fromClient(open("web", "a.ts", "v2"));
  const last = links.web.sent.at(-1);
  assert.equal(last.method, "textDocument/didChange");
  assert.deepEqual(last.params.contentChanges, [{ text: "v2" }]);
  assert.equal(last.params.textDocument.version, 2);
  assert.equal(links.web.sent.filter((m) => m.method === "textDocument/didOpen").length, 1);
});

test("the global TypeScript's own lib files go to the project that led there", () => {
  const { router, links } = setup();
  router.fromClient(open("web", "a.ts"));
  router.fromClient(hover(4, "globalts", "lib.es5.d.ts"));
  assert.equal(links.web.sent.at(-1).id, 4);
  assert.equal(links.globalts, undefined, "no server started for it");
});

test("an answer meant for a server that has since been replaced is dropped", () => {
  const { router, out, links } = setup();
  router.fromClient(open("web", "a.ts"));
  links.web.emit({ jsonrpc: "2.0", id: 0, method: "workspace/configuration", params: { items: [{}] } });
  const ours = out.at(-1).id;
  links.web.generation = 2; // released and reconnected meanwhile
  const before = links.web.sent.length;
  router.fromClient({ jsonrpc: "2.0", id: ours, result: [null] });
  assert.equal(links.web.sent.length, before);
});

test("a cancel reaches only the project holding the request", () => {
  const { router, links } = setup();
  router.fromClient(open("web", "a.ts"));
  router.fromClient(open("api", "c.ts"));
  router.fromClient(hover(4, "web", "a.ts"));
  router.fromClient({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 4 } });
  assert.equal(links.web.sent.at(-1).method, "$/cancelRequest");
  assert.notEqual(links.api.sent.at(-1).method, "$/cancelRequest");
});

test("server requests from two projects get distinct ids, and answers find their way back", () => {
  const { router, out, links } = setup();
  router.fromClient(open("web", "a.ts"));
  router.fromClient(open("api", "c.ts"));
  links.web.emit({ jsonrpc: "2.0", id: 1, method: "window/workDoneProgress/create", params: { token: "w" } });
  links.api.emit({ jsonrpc: "2.0", id: 1, method: "window/workDoneProgress/create", params: { token: "a" } });
  const [fromWeb, fromApi] = out.slice(-2);
  assert.notEqual(fromWeb.id, fromApi.id);
  router.fromClient({ jsonrpc: "2.0", id: fromApi.id, result: null });
  assert.deepEqual(links.api.sent.at(-1), { jsonrpc: "2.0", id: 1, result: null });
  assert.equal(links.web.sent.some((m) => m.result === null), false);

  links.web.emit({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 1 } });
  assert.deepEqual(out.at(-1), { jsonrpc: "2.0", method: "$/cancelRequest", params: { id: fromWeb.id } });
});

test("diagnostics and other notifications pass straight through", () => {
  const { router, out, links } = setup();
  router.fromClient(open("web", "a.ts"));
  const diag = { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: uriIn("web", "a.ts"), diagnostics: [] } };
  links.web.emit(diag);
  assert.deepEqual(out.at(-1), diag);
});

test("the router keeps each open file's latest text for re-opening", () => {
  const dir = path.join(BASE, "disk");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "d.ts"), "from disk");
  try {
    const { router, links } = setup();
    router.fromClient(open("web", "a.ts", "v1"));
    router.fromClient({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: uriIn("web", "a.ts"), version: 2 }, contentChanges: [{ text: "v2" }] } });
    router.fromClient(open("disk", "d.ts", "stale"));
    router.fromClient({
      jsonrpc: "2.0", method: "textDocument/didChange",
      params: { textDocument: { uri: uriIn("disk", "d.ts"), version: 2 }, contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, text: "F" }] },
    });
    assert.deepEqual(router.docsOf(links.web).map((d) => [d.text, d.version]), [["v2", 2]]);
    assert.equal(router.docsOf(links.disk)[0].text, "from disk", "a ranged edit is read back from disk");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("closing a file of a released project does not wake it up", () => {
  const { router, links } = setup();
  router.fromClient(open("web", "a.ts"));
  links.web.state = "idle";
  const before = links.web.sent.length;
  router.fromClient({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri: uriIn("web", "a.ts") } } });
  assert.equal(links.web.sent.length, before);
  assert.deepEqual(router.docsOf(links.web), []);
});

test("tick releases idle projects only: not busy ones, not recent ones", () => {
  const { router, links } = setup({ idleMs: 1000 });
  router.fromClient(open("web", "a.ts"));
  router.fromClient(open("api", "c.ts"));
  router.fromClient(open("busy", "e.ts"));
  router.fromClient(hover(1, "busy", "e.ts"));
  const now = Date.now();
  links.web.lastUsed = now - 5000;
  links.busy.lastUsed = now - 5000;
  router.tick(now);
  assert.equal(links.web.released, 1);
  assert.equal(links.api.released, 0, "used recently");
  assert.equal(links.busy.released, 0, "has a request in flight");
});

test("shutdown is answered here; exit closes every project and ends the shim", () => {
  const { router, out, links, exited } = setup();
  router.fromClient(open("web", "a.ts"));
  router.fromClient({ jsonrpc: "2.0", id: 8, method: "shutdown" });
  assert.deepEqual(out.at(-1), { jsonrpc: "2.0", id: 8, result: null });
  assert.equal(links.web.sent.some((m) => m.method === "shutdown"), false);
  router.fromClient({ jsonrpc: "2.0", method: "exit" });
  assert.equal(links.web.closed, 1);
  assert.equal(exited(), 0);
});
