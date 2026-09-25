import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Broker } from "../src/broker.mjs";

function setup(options = {}) {
  const backend = [];
  const events = { empty: 0, initFailed: 0 };
  const broker = new Broker({
    toBackend: (m) => backend.push(m),
    processId: 4242,
    memoryDefault: 12288,
    onEmpty: () => events.empty++,
    onInitFailed: () => events.initFailed++,
    ...options,
  });
  const join = () => {
    const inbox = [];
    const client = broker.addClient((m) => inbox.push(m), () => { client.closed = true; });
    client.inbox = inbox;
    return client;
  };
  return { broker, backend, events, join };
}

// Runs the handshake for the first session and returns the backend's init id.
function initialize(ctx, client, params = {}) {
  ctx.broker.fromClient(client, { jsonrpc: "2.0", id: 0, method: "initialize", params: { processId: 999, ...params } });
  const init = ctx.backend.find((m) => m.method === "initialize");
  ctx.broker.fromBackend({ jsonrpc: "2.0", id: init.id, result: { capabilities: { hoverProvider: true } } });
  ctx.broker.fromClient(client, { jsonrpc: "2.0", method: "initialized", params: {} });
  return init;
}

const open = (uri, text, version = 1) => ({
  jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "typescript", version, text } },
});
const change = (uri, text, version) => ({
  jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri, version }, contentChanges: [{ text }] },
});
const close = (uri) => ({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri } } });
const methods = (msgs) => msgs.map((m) => m.method ?? `response:${m.id}`);

test("initialize reaches the backend once, watching the daemon and capping memory", () => {
  const ctx = setup();
  const a = ctx.join();
  const init = initialize(ctx, a, { initializationOptions: { preferences: { x: 1 } } });
  assert.equal(init.params.processId, 4242);
  assert.equal(init.params.initializationOptions.maxTsServerMemory, 12288);
  assert.deepEqual(init.params.initializationOptions.preferences, { x: 1 });
  assert.deepEqual(a.inbox[0], { jsonrpc: "2.0", id: 0, result: { capabilities: { hoverProvider: true } } });

  const b = ctx.join();
  ctx.broker.fromClient(b, { jsonrpc: "2.0", id: 7, method: "initialize", params: {} });
  ctx.broker.fromClient(b, { jsonrpc: "2.0", method: "initialized", params: {} });
  assert.deepEqual(b.inbox[0], { jsonrpc: "2.0", id: 7, result: { capabilities: { hoverProvider: true } } });
  assert.equal(ctx.backend.filter((m) => m.method === "initialize").length, 1);
  assert.equal(ctx.backend.filter((m) => m.method === "initialized").length, 1);
});

test("a session's own memory cap is kept, and TSD_MAX_TSSERVER_MEMORY beats it", () => {
  const own = setup();
  own.broker.fromClient(own.join(), { jsonrpc: "2.0", id: 0, method: "initialize", params: { initializationOptions: { maxTsServerMemory: 3072 } } });
  assert.equal(own.backend[0].params.initializationOptions.maxTsServerMemory, 3072);

  const forced = setup({ memoryOverride: 8192 });
  forced.broker.fromClient(forced.join(), { jsonrpc: "2.0", id: 0, method: "initialize", params: { initializationOptions: { maxTsServerMemory: 3072 } } });
  assert.equal(forced.backend[0].params.initializationOptions.maxTsServerMemory, 8192);
});

test("sessions that initialize while the first is still pending all get the answer", () => {
  const ctx = setup();
  const a = ctx.join();
  const b = ctx.join();
  ctx.broker.fromClient(a, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  ctx.broker.fromClient(b, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  assert.equal(ctx.backend.length, 1);
  ctx.broker.fromBackend({ jsonrpc: "2.0", id: ctx.backend[0].id, result: { ok: true } });
  assert.deepEqual(a.inbox, [{ jsonrpc: "2.0", id: 0, result: { ok: true } }]);
  assert.deepEqual(b.inbox, [{ jsonrpc: "2.0", id: 0, result: { ok: true } }]);
});

test("a failed initialize fails every waiting session and tells the daemon", () => {
  const ctx = setup();
  const a = ctx.join();
  const b = ctx.join();
  ctx.broker.fromClient(a, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  ctx.broker.fromClient(b, { jsonrpc: "2.0", id: 5, method: "initialize", params: {} });
  const error = { code: -32603, message: "no typescript" };
  ctx.broker.fromBackend({ jsonrpc: "2.0", id: ctx.backend[0].id, error });
  assert.deepEqual(a.inbox, [{ jsonrpc: "2.0", id: 0, error }]);
  assert.deepEqual(b.inbox, [{ jsonrpc: "2.0", id: 5, error }]);
  assert.equal(ctx.events.initFailed, 1);
});

test("an initialized sent before initialize is answered reaches the backend after it", () => {
  const ctx = setup();
  const a = ctx.join();
  ctx.broker.fromClient(a, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  ctx.broker.fromClient(a, { jsonrpc: "2.0", method: "initialized", params: {} });
  assert.deepEqual(methods(ctx.backend), ["initialize"]);
  ctx.broker.fromBackend({ jsonrpc: "2.0", id: ctx.backend[0].id, result: {} });
  assert.deepEqual(methods(ctx.backend), ["initialize", "initialized"]);
  ctx.broker.fromClient(a, { jsonrpc: "2.0", method: "initialized", params: {} });
  assert.deepEqual(methods(ctx.backend), ["initialize", "initialized"]);
});

test("cancelling the shared initialize is not passed on", () => {
  const ctx = setup();
  const a = ctx.join();
  ctx.join();
  ctx.broker.fromClient(a, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  ctx.broker.fromClient(a, { jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 0 } });
  assert.deepEqual(methods(ctx.backend), ["initialize"]);
});

test("two sessions using the same request id get their own answers", () => {
  const ctx = setup();
  const a = ctx.join();
  const b = ctx.join();
  initialize(ctx, a);
  ctx.broker.fromClient(b, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  a.inbox.length = 0; b.inbox.length = 0; ctx.backend.length = 0;

  ctx.broker.fromClient(a, { jsonrpc: "2.0", id: 3, method: "textDocument/hover", params: { who: "a" } });
  ctx.broker.fromClient(b, { jsonrpc: "2.0", id: 3, method: "textDocument/hover", params: { who: "b" } });
  const [ra, rb] = ctx.backend;
  assert.notEqual(ra.id, rb.id);
  ctx.broker.fromBackend({ jsonrpc: "2.0", id: rb.id, result: "for b" });
  ctx.broker.fromBackend({ jsonrpc: "2.0", id: ra.id, result: "for a" });
  assert.deepEqual(a.inbox, [{ jsonrpc: "2.0", id: 3, result: "for a" }]);
  assert.deepEqual(b.inbox, [{ jsonrpc: "2.0", id: 3, result: "for b" }]);
});

test("$/cancelRequest is translated to the backend's id, and dropped once answered", () => {
  const ctx = setup();
  const a = ctx.join();
  initialize(ctx, a);
  ctx.backend.length = 0;
  ctx.broker.fromClient(a, { jsonrpc: "2.0", id: "req-1", method: "textDocument/references", params: {} });
  const gid = ctx.backend[0].id;
  ctx.broker.fromClient(a, { jsonrpc: "2.0", method: "$/cancelRequest", params: { id: "req-1" } });
  assert.deepEqual(ctx.backend[1], { jsonrpc: "2.0", method: "$/cancelRequest", params: { id: gid } });

  ctx.broker.fromBackend({ jsonrpc: "2.0", id: gid, result: [] });
  ctx.broker.fromClient(a, { jsonrpc: "2.0", method: "$/cancelRequest", params: { id: "req-1" } });
  assert.equal(ctx.backend.length, 2);
});

test("a document open in two sessions is opened and closed on the backend once", () => {
  const ctx = setup();
  const a = ctx.join();
  const b = ctx.join();
  initialize(ctx, a);
  ctx.backend.length = 0;

  ctx.broker.fromClient(a, open("file:///x.ts", "let x = 1;"));
  ctx.broker.fromClient(b, open("file:///x.ts", "let x = 1;"));
  // The second open re-sends the text so the backend republishes diagnostics
  // (b has none yet); it must not open the document twice.
  assert.deepEqual(methods(ctx.backend), ["textDocument/didOpen", "textDocument/didChange"]);
  assert.equal(ctx.backend[0].params.textDocument.version, 1);

  ctx.broker.fromClient(a, close("file:///x.ts"));
  assert.deepEqual(methods(ctx.backend), ["textDocument/didOpen", "textDocument/didChange"]);
  ctx.broker.fromClient(b, close("file:///x.ts"));
  assert.deepEqual(methods(ctx.backend), ["textDocument/didOpen", "textDocument/didChange", "textDocument/didClose"]);
});

test("a later opener with newer text updates the shared copy", () => {
  const ctx = setup();
  const a = ctx.join();
  const b = ctx.join();
  initialize(ctx, a);
  ctx.backend.length = 0;
  ctx.broker.fromClient(a, open("file:///x.ts", "old"));
  ctx.broker.fromClient(b, open("file:///x.ts", "new"));
  assert.deepEqual(ctx.backend[1], {
    jsonrpc: "2.0", method: "textDocument/didChange",
    params: { textDocument: { uri: "file:///x.ts", version: 2 }, contentChanges: [{ text: "new" }] },
  });
});

test("a late opener with a stale read does not roll the shared copy back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsd-broker-"));
  const file = path.join(dir, "z.ts");
  const uri = pathToFileURL(file).href;
  try {
    const ctx = setup();
    const a = ctx.join();
    const b = ctx.join();
    initialize(ctx, a);
    ctx.broker.fromClient(a, open(uri, "old"));
    fs.writeFileSync(file, "new");                      // a writes the file…
    ctx.broker.fromClient(a, change(uri, "new", 2));    // …and reports it
    ctx.backend.length = 0;
    ctx.broker.fromClient(b, open(uri, "old"));         // b read before a wrote, arrives after
    assert.deepEqual(ctx.backend[0].params.contentChanges, [{ text: "new" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("versions only ever go up for the backend, whatever the sessions number", () => {
  const ctx = setup();
  const a = ctx.join();
  const b = ctx.join();
  initialize(ctx, a);
  ctx.backend.length = 0;
  ctx.broker.fromClient(a, open("file:///x.ts", "v1", 1));
  ctx.broker.fromClient(b, open("file:///x.ts", "v1", 1));
  ctx.broker.fromClient(a, change("file:///x.ts", "v2", 2));
  ctx.broker.fromClient(b, change("file:///x.ts", "v3", 2)); // b reuses a's number
  ctx.broker.fromClient(b, change("file:///x.ts", "v3", 3));
  ctx.broker.fromClient(a, close("file:///x.ts"));
  ctx.broker.fromClient(b, close("file:///x.ts"));
  ctx.broker.fromClient(a, open("file:///x.ts", "v4", 1)); // reopened: a starts at 1 again
  const versions = ctx.backend.filter((m) => m.params.textDocument.version).map((m) => m.params.textDocument.version);
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6]);
});

test("a ranged edit is replaced by what is on disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsd-broker-"));
  const file = path.join(dir, "y.ts");
  fs.writeFileSync(file, "const y = 2;\n");
  const uri = pathToFileURL(file).href;
  try {
    const ctx = setup();
    const a = ctx.join();
    initialize(ctx, a);
    ctx.broker.fromClient(a, open(uri, "const y = 1;\n"));
    ctx.backend.length = 0;
    ctx.broker.fromClient(a, {
      jsonrpc: "2.0", method: "textDocument/didChange",
      params: { textDocument: { uri, version: 2 }, contentChanges: [{ range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } }, text: "2" }] },
    });
    assert.deepEqual(ctx.backend[0].params.contentChanges, [{ text: "const y = 2;\n" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a change for a document the session never opened is dropped", () => {
  const ctx = setup();
  const a = ctx.join();
  const b = ctx.join();
  initialize(ctx, a);
  ctx.broker.fromClient(a, open("file:///x.ts", "a"));
  ctx.backend.length = 0;
  ctx.broker.fromClient(b, change("file:///x.ts", "b", 2));
  ctx.broker.fromClient(b, close("file:///x.ts"));
  assert.deepEqual(ctx.backend, []);
});

test("diagnostics go only to the sessions that have the file open", () => {
  const ctx = setup();
  const a = ctx.join();
  const b = ctx.join();
  initialize(ctx, a);
  ctx.broker.fromClient(a, open("file:///a.ts", "a"));
  ctx.broker.fromClient(b, open("file:///b.ts", "b"));
  a.inbox.length = 0; b.inbox.length = 0;

  const diag = { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///b.ts", diagnostics: [{ message: "bad" }] } };
  ctx.broker.fromBackend(diag);
  assert.deepEqual(a.inbox, []);
  assert.deepEqual(b.inbox, [diag]);

  ctx.broker.fromBackend({ ...diag, params: { ...diag.params, uri: "file:///nobody.ts" } });
  assert.deepEqual(b.inbox, [diag]);
});

test("one file spelled two ways is one document, and its diagnostics still arrive", () => {
  // What typescript-language-server does to a Windows uri, and the same trick
  // (percent-encoding an unreserved character) for everyone else.
  const [asOpened, asPublished] = process.platform === "win32"
    ? ["file:///D:/proj/x-y.ts", "file:///d%3A/proj/x-y.ts"]
    : ["file:///proj/x-y.ts", "file:///proj/x%2Dy.ts"];
  const ctx = setup();
  const a = ctx.join();
  const b = ctx.join();
  initialize(ctx, a);
  ctx.backend.length = 0;
  ctx.broker.fromClient(a, open(asOpened, "x"));
  ctx.broker.fromClient(b, open(asPublished, "x"));
  assert.deepEqual(methods(ctx.backend), ["textDocument/didOpen", "textDocument/didChange"]);
  assert.equal(ctx.backend[1].params.textDocument.uri, asOpened, "the backend keeps the first spelling");

  a.inbox.length = 0; b.inbox.length = 0;
  const diag = { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: asPublished, diagnostics: [{ message: "bad" }] } };
  ctx.broker.fromBackend(diag);
  assert.deepEqual(a.inbox, [diag]);
  assert.deepEqual(b.inbox, [diag]);

  ctx.broker.fromClient(a, close(asPublished));
  ctx.broker.fromClient(b, close(asOpened));
  assert.equal(ctx.backend.at(-1).method, "textDocument/didClose");
  assert.equal(ctx.broker.openDocumentCount, 0);
});

test("a diagnostics version in the backend's numbering is not passed on", () => {
  const ctx = setup();
  const a = ctx.join();
  initialize(ctx, a);
  ctx.broker.fromClient(a, open("file:///a.ts", "a"));
  a.inbox.length = 0;
  ctx.broker.fromBackend({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///a.ts", version: 9, diagnostics: [] } });
  assert.deepEqual(a.inbox[0].params, { uri: "file:///a.ts", diagnostics: [] });
});

test("shutdown is answered locally; exit detaches only that session", () => {
  const ctx = setup();
  const a = ctx.join();
  const b = ctx.join();
  initialize(ctx, a);
  ctx.backend.length = 0;
  ctx.broker.fromClient(a, open("file:///x.ts", "x"));
  ctx.broker.fromClient(a, { jsonrpc: "2.0", id: 9, method: "shutdown" });
  assert.deepEqual(a.inbox.at(-1), { jsonrpc: "2.0", id: 9, result: null });
  ctx.broker.fromClient(a, { jsonrpc: "2.0", method: "exit" });
  assert.equal(a.closed, true);
  assert.equal(ctx.broker.clientCount, 1);
  assert.deepEqual(methods(ctx.backend), ["textDocument/didOpen", "textDocument/didClose"]);
  assert.equal(ctx.events.empty, 0);
  ctx.broker.removeClient(b);
  assert.equal(ctx.events.empty, 1);
});

test("a session leaving cancels its in-flight requests", () => {
  const ctx = setup();
  const a = ctx.join();
  ctx.join();
  initialize(ctx, a);
  ctx.backend.length = 0;
  ctx.broker.fromClient(a, { jsonrpc: "2.0", id: 1, method: "textDocument/hover", params: {} });
  const gid = ctx.backend[0].id;
  ctx.broker.removeClient(a);
  assert.deepEqual(ctx.backend[1], { jsonrpc: "2.0", method: "$/cancelRequest", params: { id: gid } });
  ctx.broker.fromBackend({ jsonrpc: "2.0", id: gid, result: "late" });
  assert.equal(a.inbox.some((m) => m.result === "late"), false);
});

test("server requests go to one session and its answer reaches the backend", () => {
  const ctx = setup();
  const a = ctx.join();
  const b = ctx.join();
  initialize(ctx, a);
  a.inbox.length = 0;
  ctx.backend.length = 0;

  ctx.broker.fromBackend({ jsonrpc: "2.0", id: 1, method: "window/workDoneProgress/create", params: { token: "t" } });
  assert.equal(a.inbox.length, 1);
  assert.equal(b.inbox.length, 0);
  ctx.broker.fromClient(a, { jsonrpc: "2.0", id: a.inbox[0].id, result: null });
  assert.deepEqual(ctx.backend, [{ jsonrpc: "2.0", id: 1, result: null }]);
});

test("a server request is refused for the backend when its session leaves first", () => {
  const ctx = setup();
  const a = ctx.join();
  const b = ctx.join();
  initialize(ctx, a);
  ctx.backend.length = 0;
  ctx.broker.fromBackend({ jsonrpc: "2.0", id: 1, method: "workspace/configuration", params: { items: [] } });
  ctx.broker.removeClient(a);
  assert.equal(ctx.backend[0].id, 1);
  assert.equal(ctx.backend[0].error.code, -32800);

  ctx.broker.fromBackend({ jsonrpc: "2.0", id: 2, method: "workspace/configuration", params: { items: [] } });
  assert.equal(b.inbox.at(-1).method, "workspace/configuration");
});

test("the backend cancelling its request reaches only that session, under our id", () => {
  const ctx = setup();
  const a = ctx.join();
  const b = ctx.join();
  initialize(ctx, a);
  a.inbox.length = 0;
  ctx.broker.fromBackend({ jsonrpc: "2.0", id: 7, method: "workspace/configuration", params: { items: [] } });
  const muxId = a.inbox[0].id;
  ctx.broker.fromBackend({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 7 } });
  assert.deepEqual(a.inbox[1], { jsonrpc: "2.0", method: "$/cancelRequest", params: { id: muxId } });
  assert.deepEqual(b.inbox, []);
  ctx.broker.fromBackend({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 99 } });
  assert.equal(a.inbox.length, 2);
});

test("other notifications reach every session", () => {
  const ctx = setup();
  const a = ctx.join();
  const b = ctx.join();
  initialize(ctx, a);
  a.inbox.length = 0;
  const log = { jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: "hi" } };
  ctx.broker.fromBackend(log);
  assert.deepEqual(a.inbox, [log]);
  assert.deepEqual(b.inbox, [log]);
});
