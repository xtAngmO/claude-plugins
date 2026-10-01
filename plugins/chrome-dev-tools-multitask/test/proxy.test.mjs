import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOSE_BLANK_ID, HANDSHAKE_ID, Proxy, VISIBILITY_TOOL, leftoverBlankTab, splitHeadless } from "../src/proxy.mjs";

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } };
const INIT_RESULT = { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "chrome_devtools", version: "1.10.1" } };
const TOOLS = { tools: [{ name: "list_pages", inputSchema: { type: "object" } }] };
const SHOWN_TOOLS = { tools: [...TOOLS.tools, VISIBILITY_TOOL] };
const HIDDEN = ["--headless", "--viewport=1280x800"];

function setup({ cached = true, idleMs = 1000, slotsFull = false, headless = true, busy, extraArgs = ["--no-usage-statistics"], startTimeoutMs, throwaway, live } = {}) {
  const out = [];
  const servers = [];
  const store = {};
  const events = { claimed: [], released: [], killed: [], live: [], discarded: [] };
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
      ...(busy ? { busy } : {}),
      ...(throwaway ? { throwaway, discard: (profile) => events.discarded.push(profile) } : {}),
    },
    cache: { get: (k, key) => store[k]?.[key] ?? null, set: (k, key, v) => { store[k] = { ...(store[k] ?? {}), [key]: v }; } },
    killBrowsers: (profile) => events.killed.push(profile),
    idleMs,
    extraArgs,
    cacheScope: "s",
    now: () => clock,
    ...(headless === null ? {} : { headless }),
    ...(startTimeoutMs ? { startTimeoutMs } : {}),
    live: live ?? { write: (info) => events.live.push(["write", info]), remove: () => events.live.push(["remove"]) },
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
    { jsonrpc: "2.0", id: 1, result: SHOWN_TOOLS },
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
  assert.deepEqual(s.args, ["--user-data-dir=/profiles/1", ...HIDDEN, "--no-usage-statistics"]);
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
  assert.deepEqual(t.out.at(-1), { jsonrpc: "2.0", id: 1, result: SHOWN_TOOLS }, "the session sees the visibility tool too");
  assert.deepEqual(t.store.init["s|2025-06-18"], INIT_RESULT);
  assert.deepEqual(t.store.tools["s|2025-06-18"], TOOLS, "only the server's own list is remembered");
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

test("a call arriving while the idle close is still running waits for it, then starts clean", async () => {
  const t = setup({ idleMs: 1000 });
  const order = [];
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  const first = t.servers[0];
  t.handshake(first);
  first.answer({ jsonrpc: "2.0", id: 1, result: {} });
  let finishStop;
  first.stop = () => new Promise((resolve) => { finishStop = () => { order.push("old server gone"); resolve(); }; });

  t.advance(2000);
  const closing = t.proxy.tick();
  t.client({ id: 2, method: "tools/call", params: { name: "list_pages" } });
  assert.equal(t.servers.length, 1, "no new server while the old one is still closing");
  finishStop();
  await closing;
  await new Promise((r) => setImmediate(r));
  assert.equal(t.servers.length, 2, "started once the old one was cleaned up");
  assert.deepEqual(t.events.killed, ["/profiles/1"], "the backstop ran for the old profile only");
  assert.deepEqual(t.events.released, [1], "the old slot was freed before the new claim");
  assert.equal(t.events.claimed.length, 2);
  t.handshake(t.servers[1]);
  assert.equal(t.servers[1].received.at(-1).id, 2, "the waiting call went to the new server");
});

test("a hidden browser (CDP_HEADLESS=1): set_browser_visible restarts a running one in a window", async () => {
  const t = setup();
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  const first = t.servers[0];
  assert.deepEqual(first.args.slice(1, 3), HIDDEN);
  t.handshake(first);
  first.answer({ jsonrpc: "2.0", id: 1, result: {} });

  t.client({ id: 2, method: "tools/call", params: { name: "set_browser_visible", arguments: { visible: true } } });
  await new Promise((r) => setImmediate(r));
  assert.equal(first.stopped, true, "the hidden browser was closed");
  assert.equal(first.received.some((m) => m.params?.name === "set_browser_visible"), false, "answered here, never sent to chrome-devtools-mcp");
  assert.match(t.out.at(-1).result.content[0].text, /normal window.*restarted on the same profile/s);
  assert.deepEqual(t.events.released, [1]);

  t.client({ id: 3, method: "tools/call", params: { name: "list_pages" } });
  await new Promise((r) => setImmediate(r));
  assert.equal(t.servers[1].args.includes("--headless"), false, "the next browser has a window");
});

test("set_browser_visible with no browser running just sets the mode; asking twice is a no-op", () => {
  const t = setup();
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/call", params: { name: "set_browser_visible", arguments: { visible: false } } });
  assert.match(t.out.at(-1).result.content[0].text, /already runs hidden/);
  t.client({ id: 2, method: "tools/call", params: { name: "set_browser_visible", arguments: { visible: true } } });
  assert.match(t.out.at(-1).result.content[0].text, /from the next browser action/);
  assert.equal(t.servers.length, 0, "nothing started just to change the mode");
  t.client({ id: 3, method: "tools/call", params: { name: "list_pages" } });
  assert.equal(t.servers[0].args.includes("--headless"), false);
});

test("CDP_HEADLESS=0 starts visible, and an explicit --viewport is left alone", () => {
  const visible = setup({ headless: false });
  visible.client({ id: 0, method: "initialize", params: INIT });
  visible.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  assert.equal(visible.servers[0].args.includes("--headless"), false);
});

test("with no mode configured, browsers open in a window", () => {
  const t = setup({ headless: null });
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  assert.deepEqual(t.servers[0].args, ["--user-data-dir=/profiles/1", "--no-usage-statistics"], "no --headless and no viewport of ours");
  t.client({ id: 2, method: "tools/call", params: { name: "set_browser_visible", arguments: { visible: true } } });
  assert.match(t.out.at(-1).result.content[0].text, /already runs in a normal window/);
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
  assert.deepEqual(t.servers[0].args, ["--isolated=true", ...HIDDEN, "--no-usage-statistics"]);
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

const tickOver = () => new Promise((r) => setImmediate(r));

test("a cancelled call that is still queued is never sent and never answered", () => {
  const t = setup();
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/call", params: { name: "click" } });
  t.client({ method: "notifications/cancelled", params: { requestId: 1 } });
  t.client({ id: 2, method: "tools/call", params: { name: "list_pages" } });
  t.handshake(t.servers[0]);
  const sent = t.servers[0].received.filter((m) => m.method === "tools/call").map((m) => m.id);
  assert.deepEqual(sent, [2], "the click the user cancelled never happens");
  assert.equal(t.servers[0].received.some((m) => m.method === "notifications/cancelled"), false, "nothing to tell the server");
  assert.equal(t.out.some((m) => m.id === 1), false, "a cancelled request gets no answer");
});

test("a cancelled call in flight is forwarded and stops counting, so the browser can go idle", async () => {
  const t = setup({ idleMs: 1000 });
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/call", params: { name: "performance_start_trace" } });
  t.handshake(t.servers[0]);
  t.client({ method: "notifications/cancelled", params: { requestId: 1, reason: "user" } });
  assert.deepEqual(t.servers[0].received.at(-1).params, { requestId: 1, reason: "user" });
  t.advance(5000);
  await t.proxy.tick();
  assert.equal(t.servers[0].stopped, true, "the server never answers a cancelled call; waiting for it would keep Chrome open for ever");
});

test("ping and logging/setLevel are answered at once while a server is starting", () => {
  const t = setup();
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  t.client({ id: 2, method: "ping" });
  t.client({ id: 3, method: "logging/setLevel", params: { level: "debug" } });
  assert.deepEqual(t.out.slice(-2), [{ jsonrpc: "2.0", id: 2, result: {} }, { jsonrpc: "2.0", id: 3, result: {} }]);
  t.handshake(t.servers[0]);
  const received = t.servers[0].received;
  assert.equal(received.some((m) => m.method === "ping"), false);
  assert.deepEqual(received.find((m) => m.method === "logging/setLevel").params, { level: "debug" }, "the level is replayed once the server is up");
});

test("a server that never answers initialize is given up on, and the next call tries again", async () => {
  const t = setup({ startTimeoutMs: 20 });
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(t.servers[0].stopped, true);
  assert.equal(t.out.at(-1).id, 1);
  assert.match(t.out.at(-1).error.message, /did not start in time/);
  assert.deepEqual(t.events.released, [1]);
  t.client({ id: 2, method: "tools/call", params: { name: "list_pages" } });
  await tickOver();
  assert.equal(t.servers.length, 2);
  t.handshake(t.servers[1]);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(t.servers[1].stopped, false, "a server that did answer is not timed out");
});

test("the leftover-browser kill runs only when a browser still holds the profile", async () => {
  const t = setup({ idleMs: 1000, busy: () => false });
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  t.handshake(t.servers[0]);
  t.servers[0].answer({ jsonrpc: "2.0", id: 1, result: {} });
  t.advance(2000);
  await t.proxy.tick();
  assert.deepEqual(t.events.killed, [], "a clean exit leaves nothing to look for");
  assert.deepEqual(t.events.released, [1]);
});

test("a second stop waits for the first, so no browser starts while the old one is closing", async () => {
  const t = setup({ idleMs: 1000 });
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  const first = t.servers[0];
  t.handshake(first);
  first.answer({ jsonrpc: "2.0", id: 1, result: {} });
  let finishStop;
  first.stop = () => new Promise((resolve) => { finishStop = resolve; });

  t.advance(2000);
  const closing = t.proxy.tick();
  t.client({ id: 2, method: "tools/call", params: { name: "list_pages" } }); // waits for the close
  t.client({ id: 3, method: "tools/call", params: { name: "set_browser_visible", arguments: { visible: true } } }); // a second stop
  await tickOver();
  t.client({ id: 4, method: "tools/call", params: { name: "list_pages" } });
  await tickOver();
  assert.equal(t.servers.length, 1, "nothing started while the first server is still closing");

  finishStop();
  await closing;
  await tickOver();
  await tickOver();
  assert.equal(t.servers.length, 2, "exactly one new server");
  assert.deepEqual(t.events.released, [1], "the old slot was freed before the new claim");
  assert.deepEqual(t.events.killed, ["/profiles/1"]);
  assert.equal(t.servers[1].args.includes("--headless"), false, "the new browser has the window asked for");
  t.handshake(t.servers[1]);
  const calls = t.servers[1].received.filter((m) => m.method === "tools/call").map((m) => m.id);
  assert.deepEqual(calls, [2, 4], "calls queued behind the switch carried over instead of failing");
  assert.equal(t.out.filter((m) => m.error).length, 0);
});

test("a --headless among the extra flags sets the starting mode without pinning it", async () => {
  const t = setup({ headless: false, extraArgs: ["--headless", "--viewport=1920x1080", "--slim"] });
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  assert.deepEqual(t.servers[0].args, ["--user-data-dir=/profiles/1", "--headless", "--viewport=1920x1080", "--slim"],
    "one --headless, and the viewport asked for rather than ours");
  t.handshake(t.servers[0]);
  t.client({ id: 2, method: "tools/call", params: { name: "set_browser_visible", arguments: { visible: true } } });
  await tickOver();
  t.client({ id: 3, method: "tools/call", params: { name: "list_pages" } });
  await tickOver();
  assert.deepEqual(t.servers[1].args, ["--user-data-dir=/profiles/2", "--viewport=1920x1080", "--slim"]);
});

test("splitHeadless reads every spelling of the flag and keeps the rest in order", () => {
  assert.deepEqual(splitHeadless(["--slim", "--headless", "--x"], false), { headless: true, rest: ["--slim", "--x"] });
  assert.deepEqual(splitHeadless(["--headless=true"], false), { headless: true, rest: [] });
  assert.deepEqual(splitHeadless(["--headless=false"], true), { headless: false, rest: [] });
  assert.deepEqual(splitHeadless(["--headless=0"], true), { headless: false, rest: [] });
  assert.deepEqual(splitHeadless(["--no-headless"], true), { headless: false, rest: [] });
  assert.deepEqual(splitHeadless(["--headless", "--no-headless"], true), { headless: false, rest: [] }, "the last one wins");
  assert.deepEqual(splitHeadless(["--headlessness"], true), { headless: true, rest: ["--headlessness"] }, "not a prefix match");
  assert.deepEqual(splitHeadless([], true), { headless: true, rest: [] });
});

// The live file: written when a server starts, gone the moment it stops.
const liveOps = (t) => t.events.live.map(([op, info]) => (op === "write" ? `write slot=${info.slot} ${info.profileDir} headless=${info.headless}` : op));

test("the live file is written only once a tool call starts the server, not for a session that never browses", () => {
  const t = setup();
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/list", params: {} });
  assert.deepEqual(t.events.live, [], "initialize and tools/list start nothing and announce nothing");
  t.client({ id: 2, method: "tools/call", params: { name: "list_pages" } });
  assert.deepEqual(t.events.live, [["write", { slot: 1, profileDir: "/profiles/1", headless: true }]]);
});

test("a visibility switch removes the live file with the old browser and writes it for the new one, in the new mode", async () => {
  const t = setup();
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  t.handshake(t.servers[0]);
  t.servers[0].answer({ jsonrpc: "2.0", id: 1, result: {} });
  t.client({ id: 2, method: "tools/call", params: { name: "set_browser_visible", arguments: { visible: true } } });
  await tickOver();
  assert.deepEqual(liveOps(t), ["write slot=1 /profiles/1 headless=true", "remove"]);
  t.client({ id: 3, method: "tools/call", params: { name: "list_pages" } });
  await tickOver();
  assert.deepEqual(liveOps(t).slice(2), ["write slot=2 /profiles/2 headless=false"]);
});

test("a call queued behind a visibility switch starts the new browser, and its live file, right away", async () => {
  const t = setup();
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  const first = t.servers[0];
  let finishStop;
  first.stop = () => new Promise((resolve) => { finishStop = resolve; });
  t.handshake(first);
  first.answer({ jsonrpc: "2.0", id: 1, result: {} });
  t.client({ id: 2, method: "tools/call", params: { name: "set_browser_visible", arguments: { visible: true } } });
  t.client({ id: 3, method: "tools/call", params: { name: "list_pages" } });
  assert.deepEqual(liveOps(t), ["write slot=1 /profiles/1 headless=true", "remove"], "no new file while the old browser is closing");
  finishStop();
  await tickOver();
  await tickOver();
  assert.deepEqual(liveOps(t).slice(2), ["write slot=2 /profiles/2 headless=false"]);
});

test("the live file goes whenever the server stops: idle close, crash, start timeout, session end", async () => {
  const idle = setup({ idleMs: 1000 });
  idle.client({ id: 0, method: "initialize", params: INIT });
  idle.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  idle.handshake(idle.servers[0]);
  idle.servers[0].answer({ jsonrpc: "2.0", id: 1, result: {} });
  idle.advance(2000);
  await idle.proxy.tick();
  assert.deepEqual(liveOps(idle), ["write slot=1 /profiles/1 headless=true", "remove"]);

  const crash = setup();
  crash.client({ id: 0, method: "initialize", params: INIT });
  crash.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  crash.handshake(crash.servers[0]);
  crash.servers[0].die(1);
  assert.deepEqual(liveOps(crash), ["write slot=1 /profiles/1 headless=true", "remove"]);

  const stalled = setup({ startTimeoutMs: 20 });
  stalled.client({ id: 0, method: "initialize", params: INIT });
  stalled.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(liveOps(stalled), ["write slot=1 /profiles/1 headless=true", "remove"]);

  const ended = setup();
  ended.client({ id: 0, method: "initialize", params: INIT });
  ended.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  ended.handshake(ended.servers[0]);
  await ended.proxy.close();
  assert.deepEqual(liveOps(ended), ["write slot=1 /profiles/1 headless=true", "remove"]);
});

test("with every slot taken, a throwaway profile at a known path: announced with no slot, deleted after its browser", async () => {
  const t = setup({ slotsFull: true, idleMs: 1000, throwaway: () => ({ slot: null, profile: "/tmp/cdp-mt-profile-x" }) });
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
  assert.deepEqual(t.servers[0].args, ["--user-data-dir=/tmp/cdp-mt-profile-x", ...HIDDEN, "--no-usage-statistics"]);
  assert.deepEqual(liveOps(t), ["write slot=null /tmp/cdp-mt-profile-x headless=true"]);
  t.handshake(t.servers[0]);
  t.servers[0].answer({ jsonrpc: "2.0", id: 1, result: {} });
  t.advance(2000);
  await t.proxy.tick();
  assert.deepEqual(t.events.released, [], "no slot to give back");
  assert.deepEqual(t.events.killed, ["/tmp/cdp-mt-profile-x"], "a browser left on it is closed first");
  assert.deepEqual(t.events.discarded, ["/tmp/cdp-mt-profile-x"]);
});

const pagesText = (...lines) => ({ content: [{ type: "text", text: ["## Pages", ...lines].join("\n") }] });
const newPage = (id, args = { url: "https://example.com/" }) => ({ id, method: "tools/call", params: { name: "new_page", arguments: args } });

test("a browser's first new_page closes the empty tab Chrome started with, and the session is shown the page it opened", async () => {
  const t = setup();
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ method: "notifications/initialized" });
  t.client(newPage(1));
  const [s] = t.servers;
  t.handshake(s);
  s.answer({ jsonrpc: "2.0", id: 1, result: pagesText("1: about:blank", "2: https://example.com/ [selected]") });
  assert.deepEqual(s.received.at(-1), { jsonrpc: "2.0", id: CLOSE_BLANK_ID, method: "tools/call", params: { name: "close_page", arguments: { pageId: 1 } } });
  assert.deepEqual(t.out.at(-1), { jsonrpc: "2.0", id: 1, result: pagesText("2: https://example.com/ [selected]") });
  s.answer({ jsonrpc: "2.0", id: CLOSE_BLANK_ID, result: pagesText("2: https://example.com/ [selected]") });
  assert.equal(t.out.length, 2, "the close's own answer stays between us and the server");

  // Only the first one: an empty tab the session opens later is its own business.
  t.client(newPage(2, { url: "about:blank" }));
  s.answer({ jsonrpc: "2.0", id: 2, result: pagesText("2: https://example.com/", "3: about:blank [selected]") });
  assert.equal(s.received.filter((m) => m.id === CLOSE_BLANK_ID).length, 1);
  assert.deepEqual(t.out.at(-1).result, pagesText("2: https://example.com/", "3: about:blank [selected]"));

  // A browser started again (idle close, visibility switch) has its own empty tab.
  t.advance(2000);
  await t.proxy.tick();
  t.client(newPage(3));
  const again = t.servers[1];
  t.handshake(again);
  again.answer({ jsonrpc: "2.0", id: 3, result: pagesText("1: about:blank", "2: https://example.com/ [selected]") });
  assert.deepEqual(again.received.at(-1).params, { name: "close_page", arguments: { pageId: 1 } });
});

test("a first new_page in an isolated context closes the empty tab too, which would be left alone in its window", () => {
  const t = setup();
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ method: "notifications/initialized" });
  t.client(newPage(1, { url: "https://example.com/", background: true, isolatedContext: "clean" }));
  const [s] = t.servers;
  t.handshake(s);
  s.answer({ jsonrpc: "2.0", id: 1, result: pagesText("1: about:blank", "2: https://example.com/ [selected] isolatedContext=clean") });
  assert.deepEqual(s.received.at(-1).params, { name: "close_page", arguments: { pageId: 1 } });
  assert.deepEqual(t.out.at(-1).result, pagesText("2: https://example.com/ [selected] isolatedContext=clean"));
});

test("the empty tab is kept when the session has used it before its first new_page", () => {
  const t = setup();
  t.client({ id: 0, method: "initialize", params: INIT });
  t.client({ method: "notifications/initialized" });
  t.client({ id: 1, method: "tools/call", params: { name: "navigate_page", arguments: { pageId: 1, type: "url", url: "https://used/" } } });
  const [s] = t.servers;
  t.handshake(s);
  s.answer({ jsonrpc: "2.0", id: 1, result: pagesText("1: https://used/ [selected]") });
  t.client(newPage(2, { url: "https://example.com/", isolatedContext: "clean" }));
  s.answer({ jsonrpc: "2.0", id: 2, result: pagesText("1: https://used/", "2: https://example.com/ [selected] isolatedContext=clean") });
  t.client(newPage(3));
  s.answer({ jsonrpc: "2.0", id: 3, result: pagesText("1: https://used/", "2: https://example.com/", "3: about:blank [selected]") });
  assert.equal(s.received.some((m) => m.id === CLOSE_BLANK_ID), false, "the tab was used, and only the first new_page counts");
});

test("leftoverBlankTab only answers for exactly the empty tab beside the new page", () => {
  const two = pagesText("1: about:blank", "2: Example (https://example.com/) [selected]");
  assert.deepEqual(leftoverBlankTab(two), { pageId: 1, result: pagesText("2: Example (https://example.com/) [selected]") });
  assert.equal(two.content[0].text.includes("about:blank"), true, "the server's answer itself is not changed");

  const trailing = { content: [{ type: "text", text: "## Pages\n1: about:blank\n2: https://a/ [selected]\n## Extension Pages\n5: chrome-extension://x/" }, { type: "image", data: "" }] };
  assert.deepEqual(leftoverBlankTab(trailing), {
    pageId: 1,
    result: { content: [{ type: "text", text: "## Pages\n2: https://a/ [selected]\n## Extension Pages\n5: chrome-extension://x/" }, { type: "image", data: "" }] },
  });

  const isolated = pagesText("1: about:blank", "2: A (https://a/) [selected] isolatedContext=qr b");
  assert.deepEqual(leftoverBlankTab(isolated), { pageId: 1, result: pagesText("2: A (https://a/) [selected] isolatedContext=qr b") });
  assert.equal(leftoverBlankTab(pagesText("1: about:blank isolatedContext=x", "2: https://a/ [selected]")), null, "an empty page in an isolated context is not Chrome's start tab");

  assert.equal(leftoverBlankTab(pagesText("1: https://used/", "2: https://a/ [selected]")), null, "the tab was used");
  assert.equal(leftoverBlankTab(pagesText("1: about:blank", "2: https://restored/", "3: https://a/ [selected]")), null, "more pages than the two");
  assert.equal(leftoverBlankTab(pagesText("1: about:blank [selected]", "2: https://a/")), null, "the empty tab is the selected one");
  assert.equal(leftoverBlankTab({ ...pagesText("1: about:blank", "2: https://a/ [selected]"), isError: true }), null);
  assert.equal(leftoverBlankTab({ content: [{ type: "text", text: "Navigation timeout" }] }), null);
  assert.equal(leftoverBlankTab(pagesText("1: about:blank", "something else")), null, "a list it cannot read");
  assert.equal(leftoverBlankTab(undefined), null);
});
