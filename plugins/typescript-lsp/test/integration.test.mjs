// End to end through real processes: shims, daemons and the real
// typescript-language-server, on throwaway projects whose node_modules/typescript
// links to the TypeScript installed next to typescript-language-server. Skipped
// when that is not installed. Runs in its own runtime dir and namespace, so the
// daemons your real sessions use are never touched.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.join(HERE, "..", "src", "shim.mjs");

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tsd-it-run-"));
process.env.TSD_RUN_DIR = RUN_DIR;
process.env.TSD_NAMESPACE = `it-${process.pid}`;
process.env.TSD_LOG ??= path.join(RUN_DIR, "test.log");
process.env.TSD_IDLE_MS = "3000";

const { createReader, encode, endpointFor, ensureRunDir, isAlive, rootKey, statusFile } = await import("../src/lib.mjs");
const { resolveBackend } = await import("../src/backend.mjs");
const { docKey } = await import("../src/broker.mjs");
const { siblingTsserver, typescriptVersionAt } = await import("../src/project.mjs");
ensureRunDir();

const GLOBAL_TSSERVER = siblingTsserver(resolveBackend(["--stdio"]));
const skip = GLOBAL_TSSERVER ? false : "typescript-language-server with a TypeScript next to it is not installed";
const GLOBAL_TS_VERSION = typescriptVersionAt(GLOBAL_TSSERVER);

const BAD = 'export const n: number = "text";\n';
const GOOD = "export const n: number = 1;\n";
let WORK;
const sessions = [];

before(() => { WORK = fs.mkdtempSync(path.join(os.tmpdir(), "tsd-it-work-")); });

after(async () => {
  for (const s of sessions) s.child.kill();
  for (const f of fs.readdirSync(RUN_DIR).filter((n) => n.endsWith(".status.json"))) {
    try { process.kill(JSON.parse(fs.readFileSync(path.join(RUN_DIR, f), "utf8")).daemonPid); } catch {}
  }
  await sleep(500);
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, ms = 20000, what = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// A project: its own tsconfig, a file with a type error, and node_modules/typescript.
function makeProject(name, parent = WORK) {
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  fs.copyFileSync(path.join(HERE, "fixture", "tsconfig.json"), path.join(dir, "tsconfig.json"));
  fs.writeFileSync(path.join(dir, "bad.ts"), BAD);
  const tsPackage = path.dirname(path.dirname(GLOBAL_TSSERVER));
  fs.symlinkSync(tsPackage, path.join(dir, "node_modules", "typescript"), process.platform === "win32" ? "junction" : "dir");
  return { dir, file: path.join(dir, "bad.ts"), uri: pathToFileURL(path.join(dir, "bad.ts")).href };
}

const statusOf = (root) => {
  try { return JSON.parse(fs.readFileSync(statusFile(rootKey(root)), "utf8")); } catch { return null; }
};
const hasTypeError = (diags) => diags.some((d) => /not assignable/i.test(d.message));

function startSession(root, extraEnv = {}) {
  const child = spawn(process.execPath, [SHIM, "--stdio"], {
    env: { ...process.env, ...extraEnv }, stdio: ["pipe", "pipe", "inherit"], windowsHide: true,
  });
  const messages = [];
  const waiters = new Set();
  const send = (msg) => child.stdin.write(encode(msg));
  child.stdout.on("data", createReader((msg) => {
    if (msg.method && msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, result: msg.method === "workspace/configuration" ? (msg.params?.items ?? []).map(() => null) : null });
      return;
    }
    messages.push(msg);
    for (const w of waiters) w();
  }));
  let nextId = 1;
  const s = {
    child, messages, send,
    exited: new Promise((resolve) => child.on("exit", resolve)),
    waitFor(pred, ms = 60000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const hit = messages.find(pred);
          if (!hit) return;
          waiters.delete(check); clearTimeout(timer); resolve(hit);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`timed out; last messages: ${JSON.stringify(messages.slice(-10).map((m) => m.method ?? `response:${m.id}`))}`));
        }, ms);
        waiters.add(check);
        check();
      });
    },
    request(method, params) {
      const id = nextId++;
      send({ jsonrpc: "2.0", id, method, params });
      return s.waitFor((m) => m.id === id && m.method === undefined);
    },
    notify(method, params) { send({ jsonrpc: "2.0", method, params }); },
    async initialize() {
      const res = await s.request("initialize", {
        processId: process.pid, rootUri: pathToFileURL(root).href,
        capabilities: { textDocument: { publishDiagnostics: {}, synchronization: {} }, workspace: { symbol: {} } },
      });
      s.notify("initialized", {});
      return res;
    },
    open(p) { s.notify("textDocument/didOpen", { textDocument: { uri: p.uri, languageId: "typescript", version: 1, text: fs.readFileSync(p.file, "utf8") } }); },
    edit(p, text, version) {
      fs.writeFileSync(p.file, text); // Claude Code writes the file before it reports the change
      s.notify("textDocument/didChange", { textDocument: { uri: p.uri, version }, contentChanges: [{ text }] });
    },
    diagnostics(p, pred = () => true, from = 0) {
      return s.waitFor((m) => messages.indexOf(m) >= from && m.method === "textDocument/publishDiagnostics"
        && docKey(m.params.uri) === docKey(p.uri) && pred(m.params.diagnostics));
    },
    async close() {
      await s.request("shutdown", null);
      s.notify("exit", null);
      return s.exited;
    },
  };
  sessions.push(s);
  return s;
}

test("one session above two projects: each file goes to its own project's server", { skip, timeout: 120000 }, async () => {
  const parent = path.join(WORK, "two");
  const web = makeProject("web", parent);
  const api = makeProject("api", parent);
  const s = startSession(parent);
  assert.ok((await s.initialize()).result?.capabilities);
  s.open(web);
  s.open(api);
  await s.diagnostics(web, hasTypeError);
  await s.diagnostics(api, hasTypeError);
  for (const p of [web, api]) {
    const st = await until(() => statusOf(p.dir), 10000, "status");
    assert.equal(st.clients, 1);
    assert.equal(st.typescript?.version, GLOBAL_TS_VERSION, "checked with the project's own TypeScript");
  }
  assert.equal(statusOf(parent), null, "no server for the session's own folder");

  const symbols = await s.request("workspace/symbol", { query: "n" });
  assert.ok(Array.isArray(symbols.result));
  await s.close();
});

test("sessions rooted anywhere share the project's one server", { skip, timeout: 120000 }, async () => {
  const shared = makeProject("shared");
  const a = startSession(WORK);          // started above the project
  const b = startSession(shared.dir);    // started inside it
  await a.initialize();
  const initB = await b.initialize();
  assert.ok(initB.result?.capabilities);
  a.open(shared);
  await a.diagnostics(shared, hasTypeError);
  b.open(shared);
  await b.diagnostics(shared, hasTypeError);
  const st = statusOf(shared.dir);
  assert.equal(st.clients, 2);
  assert.ok(isAlive(st.backendPid));

  assert.equal(await a.close(), 0);
  await until(() => statusOf(shared.dir)?.clients === 1, 5000, "a to detach");
  const from = b.messages.length;
  b.edit(shared, GOOD, 2);
  await b.diagnostics(shared, (d) => d.length === 0, from);
  assert.equal(statusOf(shared.dir).backendPid, st.backendPid, "same server throughout");
  await b.close();
});

test("an idle project is released, then comes back with its files when touched", { skip, timeout: 120000 }, async () => {
  const p = makeProject("idle");
  const s = startSession(p.dir, { TSD_PROJECT_IDLE_MS: "800", TSD_IDLE_CHECK_MS: "200" });
  await s.initialize();
  s.open(p);
  await s.diagnostics(p, hasTypeError);
  await until(() => statusOf(p.dir)?.clients === 0, 10000, "the release");

  const from = s.messages.length;
  s.edit(p, GOOD, 2);
  await s.diagnostics(p, (d) => d.length === 0, from);
  assert.equal(statusOf(p.dir)?.clients, 1, "reconnected");
  await s.close();
});

test("a crashed server comes back on the next edit; the session never notices", { skip, timeout: 120000 }, async () => {
  const p = makeProject("crash");
  const s = startSession(p.dir);
  await s.initialize();
  s.open(p);
  await s.diagnostics(p, hasTypeError);
  const before = statusOf(p.dir);
  process.kill(before.backendPid);
  await until(() => !isAlive(before.daemonPid), 10000, "the daemon to go down with its backend");

  const from = s.messages.length;
  s.edit(p, GOOD, 2);
  await s.diagnostics(p, (d) => d.length === 0, from);
  assert.equal(s.child.exitCode, null, "the shim is still running");
  assert.notEqual(statusOf(p.dir)?.daemonPid, before.daemonPid, "a new daemon");
  await s.close();
});

test("a daemon that hangs up before answering costs nothing: the project gets a private server", { skip, timeout: 120000 }, async () => {
  const p = makeProject("hangup");
  // Stands in for a daemon whose backend dies during initialize.
  const liar = net.createServer((sock) => sock.destroy());
  await new Promise((resolve) => liar.listen(endpointFor(rootKey(p.dir)), resolve));
  try {
    const s = startSession(p.dir);
    await s.initialize();
    s.open(p);
    await s.diagnostics(p, hasTypeError);
    await s.close();
  } finally {
    liar.close();
  }
});

test("sessions starting together end up on one daemon (over a crashed daemon's socket on unix)", { skip, timeout: 120000 }, async () => {
  const p = makeProject("race");
  if (process.platform !== "win32") {
    const endpoint = endpointFor(rootKey(p.dir));
    const holder = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(endpoint)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve) => holder.stdout.once("data", resolve));
    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.on("exit", resolve));
    assert.ok(fs.existsSync(endpoint), "stale socket left behind");
  }
  const group = [startSession(p.dir), startSession(p.dir), startSession(p.dir)];
  await Promise.all(group.map((s) => s.initialize()));
  for (const s of group) s.open(p);
  await Promise.all(group.map((s) => s.diagnostics(p, hasTypeError)));
  assert.equal(statusOf(p.dir).clients, 3, "all three on the same daemon");
  for (const s of group) await s.close();
});

test("a session that dies without saying goodbye is detached", { skip, timeout: 120000 }, async () => {
  const p = makeProject("vanish");
  const a = startSession(p.dir);
  const b = startSession(p.dir);
  await a.initialize(); await b.initialize();
  a.open(p); b.open(p);
  await a.diagnostics(p, hasTypeError); await b.diagnostics(p, hasTypeError);
  assert.equal(statusOf(p.dir).clients, 2);
  b.child.kill();
  await b.exited;
  await until(() => statusOf(p.dir)?.clients === 1, 5000, "b to detach");
  await a.close();
});

test("capabilities are learned once and cached for every later session", { skip, timeout: 120000 }, async () => {
  const p = makeProject("caps");
  const first = await startSession(p.dir).initialize();
  const cached = fs.readdirSync(RUN_DIR).filter((n) => n.startsWith("capabilities-"));
  assert.ok(cached.length >= 1, "cached on disk");
  const t0 = Date.now();
  const second = await startSession(p.dir).initialize();
  assert.deepEqual(second.result, first.result);
  assert.ok(Date.now() - t0 < 2000, "answered without starting a server");
});

test("TSD_DISABLE runs the real server directly", { skip, timeout: 120000 }, async () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "tsd-it-direct-"));
  try {
    const s = startSession(other, { TSD_DISABLE: "1" });
    const res = await s.request("initialize", { processId: process.pid, rootUri: pathToFileURL(other).href, capabilities: {} });
    assert.ok(res.result?.capabilities);
    assert.equal(statusOf(other), null, "no daemon for this root");
    s.notify("initialized", {});
    await s.close();
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});
