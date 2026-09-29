import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudePidOf, createLive } from "../src/live.mjs";
import { HANDSHAKE_ID, Proxy } from "../src/proxy.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cdp-live-"));
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const KEYS = ["version", "pid", "claudePid", "sessionId", "slot", "profileDir", "project", "headless", "startedAt"];

test("claudePid is CLAUDE_PID when Claude Code set it, else the parent process", () => {
  assert.equal(claudePidOf({ CLAUDE_PID: "5678" }, 42), 5678);
  for (const bad of [undefined, "", "0", "-3", "12.5", "abc"]) assert.equal(claudePidOf({ CLAUDE_PID: bad }, 42), 42, String(bad));
});

test("the live file is <home>/live/<pid>.json with exactly the agreed keys, written whole", () => {
  const home = tmp();
  try {
    const profile = path.join(home, "profile-3");
    const live = createLive({ home, pid: 1234, claudePid: 5678, sessionId: "3f2c", project: "d:\\github\\puipui", now: () => 1790670000000 });
    assert.equal(live.file, path.join(home, "live", "1234.json"));
    live.write({ slot: 3, profileDir: profile, headless: false });
    const got = read(live.file);
    assert.deepEqual(Object.keys(got), KEYS);
    assert.deepEqual(got, {
      version: 1, pid: 1234, claudePid: 5678, sessionId: "3f2c", slot: 3,
      profileDir: profile, project: "d:\\github\\puipui", headless: false, startedAt: 1790670000000,
    });
    assert.deepEqual(fs.readdirSync(path.join(home, "live")), ["1234.json"], "no temp file left behind");
    live.remove();
    assert.equal(fs.existsSync(live.file), false);
    live.remove(); // twice is fine
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("no session id and a throwaway profile read as null slot and null session", () => {
  const home = tmp();
  try {
    const live = createLive({ home, pid: 1, claudePid: 2, sessionId: null, project: null });
    const profile = path.join(home, "cdp-mt-profile-x");
    live.write({ slot: null, profileDir: profile, headless: true });
    const got = read(live.file);
    assert.equal(got.sessionId, null);
    assert.equal(got.slot, null);
    assert.equal(got.profileDir, profile);
    assert.equal(got.headless, true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("a write sweeps the files of plugin processes that are gone, and leaves the living ones", () => {
  const home = tmp();
  try {
    const dir = path.join(home, "live");
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ["111.json", "222.json", "notes.txt"]) fs.writeFileSync(path.join(dir, name), "{}");
    const live = createLive({ home, pid: 333, claudePid: 1, pidAlive: (p) => p === 222 });
    live.write({ slot: 1, profileDir: home, headless: false });
    assert.deepEqual(fs.readdirSync(dir).sort(), ["222.json", "333.json", "notes.txt"]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("a write that fails is logged and leaves nothing half-written", () => {
  const home = tmp();
  try {
    fs.writeFileSync(path.join(home, "live"), "a file where the folder should be");
    const logs = [];
    const live = createLive({ home, pid: 9, claudePid: 1, log: (m) => logs.push(m) });
    assert.equal(live.write({ slot: 1, profileDir: home }), null);
    assert.match(logs[0], /could not write/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// The proxy driving a real live file, against a fake chrome-devtools-mcp.
test("across start, visibility switch and stop the live file tracks the browser", async () => {
  const home = tmp();
  try {
    const servers = [];
    let claims = 0;
    const live = createLive({ home, pid: 4321, claudePid: 8765, sessionId: "sess", project: "/proj" });
    const proxy = new Proxy({
      toClient: () => {},
      startServer: ({ args, onMessage }) => {
        const s = { args, stop: async () => {}, write: () => {}, answer: onMessage };
        servers.push(s);
        return s;
      },
      slots: { claim: () => { claims++; return { slot: 3, profile: path.join(home, "profile-3") }; }, release: () => {}, busy: () => false },
      cache: { get: (kind) => (kind === "init" ? { protocolVersion: "2025-06-18" } : null), set: () => {} },
      headless: false,
      live,
    });
    const client = (m) => proxy.fromClient({ jsonrpc: "2.0", ...m });
    const settle = () => new Promise((r) => setImmediate(r));

    client({ id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    assert.equal(fs.existsSync(live.file), false, "nothing until a tool is called");

    client({ id: 1, method: "tools/call", params: { name: "list_pages" } });
    const started = read(live.file);
    assert.deepEqual(
      { pid: started.pid, claudePid: started.claudePid, sessionId: started.sessionId, slot: started.slot, profileDir: started.profileDir, project: started.project, headless: started.headless },
      { pid: 4321, claudePid: 8765, sessionId: "sess", slot: 3, profileDir: path.join(home, "profile-3"), project: "/proj", headless: false },
    );
    servers[0].answer({ jsonrpc: "2.0", id: HANDSHAKE_ID, result: {} });

    client({ id: 2, method: "tools/call", params: { name: "set_browser_visible", arguments: { visible: false } } });
    assert.equal(fs.existsSync(live.file), false, "the old browser is on its way out");
    await settle();
    client({ id: 3, method: "tools/call", params: { name: "list_pages" } });
    await settle();
    assert.equal(servers.length, 2);
    const switched = read(live.file);
    assert.equal(switched.headless, true, "rewritten for the hidden browser");
    assert.equal(switched.slot, 3);
    assert.ok(switched.startedAt >= started.startedAt);

    servers[1].answer({ jsonrpc: "2.0", id: HANDSHAKE_ID, result: {} });
    await proxy.close();
    assert.equal(fs.existsSync(live.file), false, "gone with the session");
    assert.equal(claims, 2);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
