// End to end with the real chrome-devtools-mcp and a real (headless) Chrome, in
// a throwaway CDP_HOME so your own profiles and slots are never touched.
// Skipped when chrome-devtools-mcp@1.10.1 is not in npx's cache yet.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { frame, lineReader } from "../src/lines.mjs";
import { cachedEntry, killBrowsersOn } from "../src/server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "chrome-devtools-multitask.mjs");
const SPEC = "chrome-devtools-mcp@1.10.1";
const skip = cachedEntry(SPEC) ? false : `${SPEC} is not in npx's cache (run it once with npx)`;

let HOME;
let WORK;
const sessions = [];

before(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-it-home-"));
  WORK = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-it-work-"));
});

after(async () => {
  for (const s of sessions) { try { s.child.stdin.end(); } catch {} }
  await sleep(1500);
  for (const s of sessions) { try { s.child.kill(); } catch {} }
  killBrowsersOn(path.join(HOME, "chrome-profile"));
  for (let n = 2; n <= 3; n++) killBrowsersOn(path.join(HOME, `profile-${n}`));
  await sleep(500);
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 5 });
  fs.rmSync(WORK, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function project(name) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

// The command lines of the browsers running on exactly this profile.
function browserCommandLines(profile) {
  const needle = profile.toLowerCase();
  const script = "$ProgressPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='chrome-headless-shell.exe'\" | ForEach-Object { $_.CommandLine }";
  const out = process.platform === "win32"
    ? execFileSync("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    : execFileSync("ps", ["-A", "-o", "args="], { encoding: "utf8" });
  return out.split(/\r?\n/).filter((l) => l.toLowerCase().includes(`--user-data-dir=${needle}`));
}
const browsersOn = (profile) => browserCommandLines(profile).length;

const liveFileOf = (pid) => path.join(HOME, "live", `${pid}.json`);

async function waitFor(what, check, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const got = check();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

// The profile of the slot a session holds, read from the lock files it wrote.
function profileHeldBy(pid) {
  const lock = fs.readdirSync(path.join(HOME, "slots")).find((f) => f.endsWith(".lock") && fs.readFileSync(path.join(HOME, "slots", f), "utf8") === String(pid));
  if (!lock) return null;
  const n = Number(lock.match(/\d+/)[0]);
  return { lock, profile: n === 1 ? path.join(HOME, "chrome-profile") : path.join(HOME, `profile-${n}`) };
}

function start(cwd, env = {}) {
  const child = spawn(process.execPath, [BIN], {
    cwd,
    // Idle long enough that checking for a browser (a slow process query on
    // Windows) never races the idle close.
    // Hidden, so the suite never opens windows (browsers are visible by default).
    env: { ...process.env, CDP_HOME: HOME, CDP_EXTRA_ARGS: "", CDP_HEADLESS: "1", CDP_IDLE_MINUTES: "0.15", CDP_TICK_MS: "300", ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const messages = [];
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", lineReader((m) => messages.push(m)));
  child.stderr.on("data", (d) => { stderr += d; });
  let nextId = 1;
  const s = {
    child, messages,
    get stderr() { return stderr; },
    async request(method, params, ms = 90000) {
      const id = nextId++;
      child.stdin.write(frame({ jsonrpc: "2.0", id, method, params }));
      const end = Date.now() + ms;
      for (;;) {
        const hit = messages.find((m) => m.id === id && m.method === undefined);
        if (hit) return hit;
        if (Date.now() > end) throw new Error(`timed out on ${method}; stderr: ${stderr.slice(-400)}`);
        await sleep(50);
      }
    },
    notify(method, params) { child.stdin.write(frame({ jsonrpc: "2.0", method, params })); },
    async open() {
      const init = await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "it", version: "0" } });
      s.notify("notifications/initialized");
      return init;
    },
    async end() {
      child.stdin.end();
      await new Promise((r) => (child.exitCode !== null ? r() : child.on("exit", r)));
    },
  };
  sessions.push(s);
  return s;
}

test("the first session learns the tools from the real server; later ones never start it to ask", { skip, timeout: 180000 }, async () => {
  // An extra flag skips the bundled snapshot, so this session has to learn.
  const learnEnv = { CDP_EXTRA_ARGS: "--no-performance-crux" };
  const first = start(project("learn"), learnEnv);
  const init = await first.open();
  assert.equal(init.result.serverInfo.name, "chrome_devtools");
  const tools = await first.request("tools/list", {});
  assert.ok(tools.result.tools.length >= 20);
  const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(first.stderr, new RegExp(`starting ${literal(SPEC)} via .*${literal("chrome-devtools-mcp.js")}`), "run straight from npx's cache, no npx process");
  await first.end();

  const later = start(project("learn"), learnEnv);
  const t0 = Date.now();
  await later.open();
  const again = await later.request("tools/list", {});
  assert.deepEqual(again.result, tools.result);
  assert.ok(again.result.tools.some((x) => x.name === "set_browser_visible"), "with the visibility tool");
  assert.ok(Date.now() - t0 < 2000);
  assert.doesNotMatch(later.stderr, /starting/, "no server started");
  await later.end();
});

test("a machine's very first session is answered from the bundled snapshot, no server started", { timeout: 60000 }, async () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-it-fresh-"));
  try {
    // Default flags (no CDP_EXTRA_ARGS) and nothing learned yet in this home.
    const s = start(project("fresh"), { CDP_HOME: fresh, CDP_EXTRA_ARGS: "" });
    const t0 = Date.now();
    const init = await s.open();
    const tools = await s.request("tools/list", {});
    assert.equal(init.result.serverInfo.version, SPEC.split("@").pop());
    assert.equal(tools.result.tools.length, 31, "chrome-devtools-mcp's 30 plus set_browser_visible");
    assert.ok(Date.now() - t0 < 2000);
    assert.doesNotMatch(s.stderr, /starting/, "no server, no download");
    await s.end();
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});

test("two sessions browsing at once get two browsers on two profiles", { skip, timeout: 180000 }, async () => {
  const a = start(project("alpha"));
  const b = start(project("beta"));
  await a.open(); await b.open();
  const pagesA = await a.request("tools/call", { name: "list_pages", arguments: {} });
  const pagesB = await b.request("tools/call", { name: "list_pages", arguments: {} });
  assert.match(pagesA.result.content[0].text, /about:blank/);
  assert.match(pagesB.result.content[0].text, /about:blank/);
  const heldA = profileHeldBy(a.child.pid);
  const heldB = profileHeldBy(b.child.pid);
  assert.ok(heldA && heldB, "each session holds a slot");
  assert.notEqual(heldA.profile, heldB.profile, "and they are different profiles");
  assert.ok(browsersOn(heldA.profile) > 0, "a's browser runs on a's profile");
  assert.ok(browsersOn(heldB.profile) > 0, "b's on b's");
  await a.end(); await b.end();
  await sleep(1000);
  assert.equal(browsersOn(heldA.profile), 0, "a's browser closed with its session");
  assert.equal(browsersOn(heldB.profile), 0, "b's too");
});

test("an unused browser is closed and its slot freed; the next call reopens it on the same project's profile", { skip, timeout: 180000 }, async () => {
  const dir = project("sticky");
  const s = start(dir);
  await s.open();
  await s.request("tools/call", { name: "list_pages", arguments: {} });
  const held = profileHeldBy(s.child.pid);
  assert.ok(held, "a slot is held while browsing");
  const { lock, profile } = held;
  assert.ok(browsersOn(profile) > 0);
  assert.ok(fs.existsSync(liveFileOf(s.child.pid)), "the live file names the running browser");

  const end = Date.now() + 30000;
  while (fs.existsSync(path.join(HOME, "slots", lock)) && Date.now() < end) await sleep(300);
  assert.equal(fs.existsSync(path.join(HOME, "slots", lock)), false, "slot released after the idle time");
  assert.equal(browsersOn(profile), 0, "and the browser closed");
  assert.match(s.stderr, /closing it/);
  assert.equal(fs.existsSync(liveFileOf(s.child.pid)), false, "the live file went with it");

  const again = await s.request("tools/call", { name: "list_pages", arguments: {} });
  assert.match(again.result.content[0].text, /about:blank/);
  assert.equal(fs.readFileSync(path.join(HOME, "slots", lock), "utf8"), String(s.child.pid), "same slot, same profile");
  assert.equal(JSON.parse(fs.readFileSync(liveFileOf(s.child.pid), "utf8")).profileDir, profile, "and back for the reopened browser");
  await s.end();
});

test("each browser answers on a local debug port, and a live file names the session that owns it", { skip, timeout: 180000 }, async () => {
  const s = start(project("live"), { CLAUDE_PID: "424242", CLAUDE_CODE_SESSION_ID: "it-session" });
  await s.open();
  assert.equal(fs.existsSync(liveFileOf(s.child.pid)), false, "no browser yet, no live file");
  await s.request("tools/call", { name: "list_pages", arguments: {} });
  const held = profileHeldBy(s.child.pid);
  assert.ok(held);

  const record = JSON.parse(fs.readFileSync(liveFileOf(s.child.pid), "utf8"));
  assert.deepEqual(Object.keys(record), ["version", "pid", "claudePid", "sessionId", "slot", "profileDir", "project", "headless", "startedAt"]);
  assert.equal(record.version, 1);
  assert.equal(record.pid, s.child.pid);
  assert.equal(record.claudePid, 424242);
  assert.equal(record.sessionId, "it-session");
  assert.equal(record.slot, Number(held.lock.match(/\d+/)[0]));
  assert.equal(record.profileDir, held.profile);
  assert.equal(record.headless, true);

  // Chrome writes the port it picked into the profile: line 1 the port, line 2 the browser's ws path.
  const activePort = path.join(record.profileDir, "DevToolsActivePort");
  const [port, wsPath] = await waitFor("DevToolsActivePort", () => fs.existsSync(activePort) && fs.readFileSync(activePort, "utf8").split(/\r?\n/));
  assert.match(port, /^\d+$/);
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  assert.equal(res.status, 200);
  const version = await res.json();
  assert.match(version.Browser, /Chrome/);
  assert.ok(version.webSocketDebuggerUrl.endsWith(wsPath), "the port belongs to this browser");

  const [cmd] = browserCommandLines(record.profileDir).filter((l) => !l.includes("--type="));
  assert.match(cmd, /--remote-debugging-port=0/);
  assert.match(cmd, /--remote-debugging-pipe/, "chrome-devtools-mcp still talks to it over the pipe");

  await s.end();
  assert.equal(fs.existsSync(liveFileOf(s.child.pid)), false, "the live file is gone with the session");
});

test("with every slot taken, the throwaway profile is one the live file can name, and it is deleted afterwards", { skip, timeout: 180000 }, async () => {
  const one = { CDP_MAX_SLOTS: "1" };
  const holder = start(project("holder"), one);
  await holder.open();
  await holder.request("tools/call", { name: "list_pages", arguments: {} });
  const extra = start(project("extra"), one);
  await extra.open();
  const pages = await extra.request("tools/call", { name: "list_pages", arguments: {} });
  assert.match(pages.result.content[0].text, /about:blank/);

  const record = JSON.parse(fs.readFileSync(liveFileOf(extra.child.pid), "utf8"));
  assert.equal(record.slot, null);
  assert.match(path.basename(record.profileDir), /^cdp-mt-profile-/);
  assert.ok(browsersOn(record.profileDir) > 0, "its browser runs there");
  const activePort = path.join(record.profileDir, "DevToolsActivePort");
  const [port] = await waitFor("DevToolsActivePort", () => fs.existsSync(activePort) && fs.readFileSync(activePort, "utf8").split(/\r?\n/));
  assert.equal((await fetch(`http://127.0.0.1:${port}/json/version`)).status, 200);

  await extra.end();
  assert.equal(fs.existsSync(record.profileDir), false, "the throwaway profile is gone with its browser");
  assert.equal(fs.existsSync(liveFileOf(extra.child.pid)), false);
  await holder.end();
});
