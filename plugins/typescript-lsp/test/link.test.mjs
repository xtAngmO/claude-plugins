import { test } from "node:test";
import assert from "node:assert/strict";
import { ProjectLink } from "../src/link.mjs";

const tick = () => new Promise((r) => setImmediate(r));

// A transport the test drives: it records what the link writes, and the test
// plays the server by calling `answer` / `hangUp`.
function harness({ docs = [], initTimeoutMs = 60000, failOpen = false } = {}) {
  const opened = [];     // { usePrivate, transport }
  const toSession = [];
  const link = new ProjectLink({
    project: { root: "/p", key: "p" },
    args: [],
    log: () => {},
    initParams: () => ({ rootUri: "file:///p" }),
    onMessage: (_l, m) => toSession.push(m),
    reopen: () => docs,
    initTimeoutMs,
    transport: async ({ usePrivate, onMessage, onClose }) => {
      if (failOpen) throw new Error("spawn EMFILE");
      const t = {
        kind: usePrivate ? "private" : "shared",
        written: [],
        closed: false,
        write: (m) => t.written.push(m),
        close: () => { t.closed = true; },
        answer: (m) => onMessage(m),
        hangUp: () => onClose(),
      };
      opened.push({ usePrivate, t });
      return t;
    },
  });
  const current = () => opened.at(-1).t;
  const answerInit = () => current().answer({ jsonrpc: "2.0", id: "tsd:init", result: { capabilities: {} } });
  return { link, opened, toSession, current, answerInit };
}

const open = (uri, text = "x") => ({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "typescript", version: 1, text } } });
const close = (uri) => ({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri } } });
const hover = (id) => ({ jsonrpc: "2.0", id, method: "textDocument/hover", params: { textDocument: { uri: "file:///p/a.ts" }, position: { line: 0, character: 0 } } });

test("messages wait for initialize, then go out after initialized", async () => {
  const h = harness();
  h.link.send(hover(1));
  await tick();
  assert.equal(h.link.state, "connecting");
  assert.deepEqual(h.current().written.map((m) => m.method), ["initialize"]);
  h.answerInit();
  assert.equal(h.link.state, "ready");
  assert.deepEqual(h.current().written.map((m) => m.method), ["initialize", "initialized", "textDocument/hover"]);
  assert.ok(h.link.inflight.size === 1);
});

test("open, close, open while connecting: the re-open wins and no stale close follows it", async () => {
  const uri = "file:///p/a.ts";
  const h = harness({ docs: [{ uri, languageId: "typescript", version: 3, text: "latest" }] });
  h.link.send(open(uri));
  h.link.send(close(uri));
  h.link.send(open(uri));
  await tick();
  h.answerInit();
  const docTraffic = h.current().written.filter((m) => m.method?.startsWith("textDocument/"));
  assert.equal(docTraffic.length, 1, JSON.stringify(docTraffic.map((m) => m.method)));
  assert.equal(docTraffic[0].method, "textDocument/didOpen");
});

test("a daemon that hangs up before initialize → private for now, shared again after a release", async () => {
  const h = harness();
  h.link.send(hover(1));
  await tick();
  assert.equal(h.opened[0].usePrivate, false);
  h.current().hangUp();
  await tick();
  assert.equal(h.opened[1].usePrivate, true, "went private");
  h.answerInit();
  h.current().answer({ jsonrpc: "2.0", id: 1, result: null });
  assert.equal(h.link.release(), true);
  h.link.send(hover(2));
  await tick();
  assert.equal(h.opened[2].usePrivate, false, "tries the daemon again");
});

test("a server that never answers initialize is given up on, not waited for forever", async () => {
  const h = harness({ initTimeoutMs: 30 });
  h.link.send(hover(1));
  await tick();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(h.opened[0].t.closed, true, "the silent daemon connection is closed");
  assert.equal(h.opened.length, 2, "and a private server is tried");
  assert.equal(h.opened[1].usePrivate, true);
});

test("a transport that cannot even start fails the link and refuses what was queued", async () => {
  const h = harness({ failOpen: true });
  h.link.send(hover(1));
  await tick();
  await tick();
  assert.equal(h.link.state, "failed");
  assert.equal(h.toSession[0].id, 1);
  assert.match(h.toSession[0].error.message, /EMFILE/);
});

test("losing a ready server fails what was in flight; the next message reconnects", async () => {
  const h = harness();
  h.link.send(hover(1));
  await tick();
  h.answerInit();
  const generation = h.link.generation;
  h.current().hangUp();
  assert.deepEqual(h.toSession.map((m) => m.id), [1]);
  assert.equal(h.toSession[0].error.code, -32803);
  assert.equal(h.link.state, "idle");
  h.link.send(hover(2));
  await tick();
  h.answerInit();
  assert.equal(h.link.generation, generation + 1);
  assert.equal(h.current().written.at(-1).id, 2);
});

test("three crashes in two minutes pause the project; requests are refused meanwhile", async () => {
  const h = harness();
  for (let i = 1; i <= 3; i++) {
    h.link.send(hover(i));
    await tick();
    h.answerInit();
    h.current().hangUp();
  }
  assert.equal(h.link.state, "failed");
  h.toSession.length = 0;
  h.link.send(hover(9));
  assert.equal(h.toSession[0].id, 9);
  assert.match(h.toSession[0].error.message, /keeps/);
});

test("cancelling a queued request answers it once and never sends it", async () => {
  const h = harness();
  h.link.send(hover(1));
  h.link.send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 1 } });
  assert.deepEqual(h.toSession, [{ jsonrpc: "2.0", id: 1, error: { code: -32800, message: "cancelled" } }]);
  await tick();
  h.answerInit();
  assert.equal(h.current().written.some((m) => m.id === 1), false);
});

test("a link still owed diagnostics for an open or edit is not released", async () => {
  const h = harness();
  const uri = "file:///p/a.ts";
  h.link.send(open(uri));
  await tick();
  h.answerInit();
  assert.equal(h.link.release(), false, "the server has not published diagnostics yet");
  h.current().answer({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
  assert.equal(h.link.release(), true);
});

test("release only when nothing is in flight", async () => {
  const h = harness();
  h.link.send(hover(1));
  await tick();
  h.answerInit();
  assert.equal(h.link.release(), false);
  h.current().answer({ jsonrpc: "2.0", id: 1, result: null });
  assert.equal(h.link.release(), true);
  assert.equal(h.opened[0].t.closed, true);
});
