import { test } from "node:test";
import assert from "node:assert/strict";
import { HANDSHAKE_ID, Proxy } from "../src/proxy.mjs";

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } };
const INIT_RESULT = { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "chrome_devtools", version: "1.9.0" } };
const TOOLS = { tools: [{ name: "list_pages", inputSchema: { type: "object" } }] };

function setup({ cached = true, idleMs = 1000, slotsFull = false } = {}) {
  const out = [];
  const servers = [];
  const store = {};
  const events = { claimed: [], released: [], killed: [] };
  let clock = 0;
  if (cached) store["init"] = { "s|2025-06-18": INIT_RESULT }, store["tools"] = { "s|2025-06-18": TOOLS };
  const proxy = new Proxy({
    toClient: (m) => out.push(m),
    startServer: ({ args, onMessage, onExit }) => {
      const s = { args, received: [], stopped: false, write: (m) => s.received.push(m), stop: async () => { s.stopped = true; }, answer: onMessage, die: onExit };
      servers.push(s);
      return s;
    },
    slots: {
      claim: () => { if (slotsFull) return null; const c = { slot: events.claimed.length + 1, profile: `/profiles/${events.claimed.length + 1}` }; events.claimed.push(c); return c; },
      release: (n) => events.released.push(n),
    },
    cache: { get: (k, key) => store[k]?.[key] ?? null, set: (k, key, v) => { store[k] = { ...(store[k] ?? {}), [key]: v }; } },
    killBrowsers: (profile) => events.killed.push(profile),
    idleMs,
    extraArgs: ["--no-usage-statistics"],
    cacheScope: "s",
    now: () => clock,
  });
  const client = (m) => proxy.fromClient({ jsonrpc: "2.0", ...m });
  const handshake = (s) => s.answer({ jsonrpc: "2.0", id: HANDSHAKE_ID, result: INIT_RESULT });
  return { proxy, out, servers, store, events, client, handshake, advance: (ms) => { clock += ms; } };
}

test("a session that never browses never starts a server", () => {
  const t = setup();
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ method: "notifications/initialized" });
  t.client({ id: 1, method: "tools/list", params: {} });
  t.client({ id: 2, method: "ping" });
  t.client({ id: 3, method: "logging/setLevel", params: { level: "info" } });
  assert.deepEqual(t.out, [
    { jsonrpc: "2.0", id: 0, result: INIT_RESULT },
    { jsonrpc: "2.0", id: 1, result: TOOLS },
    { jsonrpc: "2.0", id: 2, result: {} },
    { jsonrpc: "2.0", id: 3, result: {} },
  ]);
  assert.equal(t.servers.length, 0);
  assert.equal(t.events.claimed.length, 0, "no slot taken either");
});

test("the first call starts the server on a slot, replays the handshake, then runs the call", () => {
  const t = setup();
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ method: "notifications/initialized" });
  t.client({ id: 3, method: "logging/setLevel", params: { level: "info" } });
  t.client({ id: 5, method: "tools/call", params: { name: "list_pages", arguments: {} } });
  const [s] = t.servers;
  assert.deepEqual(s.args, ["--user-data-dir=/profiles/1", "--no-usage-statistics"]);
  assert.deepEqual(s.received, [{ jsonrpc: "2.0", id: HANDSHAKE_ID, method: "initialize", params: INIT }]);
  t.handshake(s);
  assert.deepEqual(s.received.slice(1).map((m) => m.method), ["notifications/initialized", "logging/setLevel", "tools/call"]);
  assert.equal(t.out.some((m) => m.id === HANDSHAKE_ID), false, "the replayed handshake stays between us and the server");
  s.answer({ jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: "1: about:blank" }] } });
  assert.deepEqual(t.out.at(-1), { jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: "1: about:blank" }] } });
});

test("first run: the real server answers initialize and tools/list, and both are kept", () => {
  const t = setup({ cached: false });
  t.client({ id: 0, method: "initialize", params: INIT });
  const [s] = t.servers;
  assert.equal(s.received[0].id, 0, "the client's own initialize goes through");
  s.answer({ jsonrpc: "2.0", id: 0, result: INIT_RESULT });
  assert.deepEqual(t.out[0], { jsonrpc: "2.0", id: 0, result: INIT_RESULT });
  t.client({ method: "notifications/initialized" });
  t.client({ id: 1, method: "tools/list", params: {} });
  s.answer({ jsonrpc: "2.0", id: 1, result: TOOLS });
  assert.deepEqual(t.store.init["s|2025-06-18"], INIT_RESULT);
  assert.deepEqual(t.store.tools["s|2025-06-18"], TOOLS);
  assert.equal(s.received.filter((m) => m.method === "notifications/initialized").length, 1);
});

test("an unused browser is closed after the idle time, and comes back on the next call", async () => {
  const t = setup({ idleMs: 1000 });
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ method: "notifications/initialized" });
  t.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  t.handshake(t.servers[0]);
  t.servers[0].answer({ jsonrpc: "2.0", id: 1, result: {} });

  t.advance(500);
  await t.proxy.tick();
  assert.equal(t.servers[0].stopped, false, "not idle long enough");
  t.advance(600);
  await t.proxy.tick();
  assert.equal(t.servers[0].stopped, true);
  assert.deepEqual(t.events.killed, ["/profiles/1"], "the backstop looked for a leftover browser");
  assert.deepEqual(t.events.released, [1]);
  assert.equal(t.proxy.state, "stopped");

  t.client({ id: 2, method: "tools/call", params: { name: "list_pages" } });
  assert.equal(t.servers.length, 2, "a new server");
  assert.equal(t.servers[1].received[0].id, HANDSHAKE_ID);
});

test("a call still running keeps the browser open", async () => {
  const t = setup({ idleMs: 1000 });
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/call", params: { name: "performance_start_trace" } });
  t.handshake(t.servers[0]);
  t.advance(5000);
  await t.proxy.tick();
  assert.equal(t.servers[0].stopped, false);
});

test("a server that dies fails what it owed, frees its slot, and the next call starts another", () => {
  const t = setup();
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  t.handshake(t.servers[0]);
  t.servers[0].die(1);
  assert.equal(t.out.at(-1).id, 1);
  assert.match(t.out.at(-1).error.message, /exit 1/);
  assert.deepEqual(t.events.released, [1]);
  t.client({ id: 2, method: "tools/call", params: { name: "list_pages" } });
  assert.equal(t.servers.length, 2);
});

test("a server that dies while starting fails the queued calls instead of leaving them hanging", () => {
  const t = setup();
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  t.servers[0].die(1);
  assert.deepEqual(t.out.map((m) => m.id), [0, 1]);
  assert.ok(t.out[1].error);
});

test("a refused first-run initialize is answered exactly once", () => {
  const t = setup({ cached: false });
  t.client({ id: 0, method: "initialize", params: INIT });
  t.servers[0].answer({ jsonrpc: "2.0", id: 0, error: { code: -32602, message: "bad" } });
  assert.equal(t.out.filter((m) => m.id === 0).length, 1);
});

test("server requests reach the client, and the client's answer reaches the server", () => {
  const t = setup();
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  const s = t.servers[0];
  t.handshake(s);
  s.answer({ jsonrpc: "2.0", id: 0, method: "roots/list" });
  assert.deepEqual(t.out.at(-1), { jsonrpc: "2.0", id: 0, method: "roots/list" });
  t.client({ id: 0, result: { roots: [] } });
  assert.deepEqual(s.received.at(-1), { jsonrpc: "2.0", id: 0, result: { roots: [] } });
});

test("with every slot taken the browser gets a throwaway profile", () => {
  const t = setup({ slotsFull: true });
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  assert.deepEqual(t.servers[0].args, ["--isolated=true", "--no-usage-statistics"]);
});

test("notifications for a server that is not running go nowhere", () => {
  const t = setup();
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ method: "notifications/cancelled", params: { requestId: 7 } });
  assert.equal(t.servers.length, 0);
});

test("closing the session stops the server and gives the slot back", async () => {
  const t = setup();
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  t.handshake(t.servers[0]);
  t.servers[0].answer({ jsonrpc: "2.0", id: 1, result: {} });
  await t.proxy.close();
  assert.equal(t.servers[0].stopped, true);
  assert.deepEqual(t.events.released, [1]);
});
