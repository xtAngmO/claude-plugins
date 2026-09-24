// End to end through real processes: two shims, one daemon, one real
// typescript-language-server. Skipped when typescript-language-server is not
// installed. Runs in its own runtime dir and namespace so a live tsserverd on
// the same machine is never touched.
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
process.env.TSD_IDLE_MS = "1500";

const { createReader, encode, endpointFor, ensureRunDir, isAlive, rootKey, statusFile } = await import("../src/lib.mjs");
ensureRunDir();
const { resolveBackend } = await import("../src/backend.mjs");
const { docKey } = await import("../src/broker.mjs");
const skip = resolveBackend(["--stdio"]) ? false : "typescript-language-server is not installed";

let project;
let badUri;
const sessions = [];

before(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "tsd-it-project-"));
  fs.copyFileSync(path.join(HERE, "fixture", "tsconfig.json"), path.join(project, "tsconfig.json"));
  fs.writeFileSync(path.join(project, "bad.ts"), 'export const n: number = "text";\n');
  badUri = pathToFileURL(path.join(project, "bad.ts")).href;
});

after(async () => {
  for (const s of sessions) s.child.kill();
  try {
    const status = JSON.parse(fs.readFileSync(statusFile(rootKey(project)), "utf8"));
    process.kill(status.daemonPid);
  } catch {}
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
});

function startSession(extraEnv = {}) {
  const child = spawn(process.execPath, [SHIM, "--stdio"], {
    env: { ...process.env, ...extraEnv },
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  const messages = [];
  const waiters = new Set();
  const send = (msg) => child.stdin.write(encode(msg));
  child.stdout.on("data", createReader((msg) => {
    // Answer what the server asks so it never stalls on us.
    if (msg.method && msg.id !== undefined) {
      const result = msg.method === "workspace/configuration" ? (msg.params?.items ?? []).map(() => null) : null;
      send({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    messages.push(msg);
    for (const w of waiters) w();
  }));
  let nextId = 1;
  const session = {
    child,
    messages,
    send,
    exited: new Promise((resolve) => child.on("exit", resolve)),
    waitFor(pred, ms = 60000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const hit = messages.find(pred);
          if (!hit) return;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(hit);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          const seen = messages.slice(-15).map((m) => m.method ?? `response:${m.id}`);
          reject(new Error(`timed out; last messages: ${JSON.stringify(seen)}`));
        }, ms);
        waiters.add(check);
        check();
      });
    },
    request(method, params) {
      const id = nextId++;
      send({ jsonrpc: "2.0", id, method, params });
      return session.waitFor((m) => m.id === id && m.method === undefined);
    },
    notify(method, params) { send({ jsonrpc: "2.0", method, params }); },
    async initialize() {
      const res = await session.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(project).href,
        capabilities: { textDocument: { publishDiagnostics: {}, synchronization: {} }, workspace: {} },
      });
      session.notify("initialized", {});
      return res;
    },
    open(uri, text) {
      session.notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text } });
    },
    // The server respells uris (file:///D:/… comes back as file:///d%3A/…).
    diagnosticsFor(uri, pred = () => true) {
      return session.waitFor((m) => m.method === "textDocument/publishDiagnostics"
        && docKey(m.params.uri) === docKey(uri) && pred(m.params.diagnostics));
    },
    async close() {
      await session.request("shutdown", null);
      session.notify("exit", null);
      return session.exited;
    },
  };
  sessions.push(session);
  return session;
}

const readStatus = () => JSON.parse(fs.readFileSync(statusFile(rootKey(project)), "utf8"));
const hasTypeError = (diags) => diags.some((d) => /not assignable/i.test(d.message));

test("two sessions share one backend and both get diagnostics", { skip, timeout: 120000 }, async () => {
  const a = startSession();
  const initA = await a.initialize();
  assert.ok(initA.result?.capabilities, "session a initialized");
  a.open(badUri, fs.readFileSync(new URL(badUri), "utf8"));
  await a.diagnosticsFor(badUri, hasTypeError);

  const b = startSession();
  const initB = await b.initialize();
  assert.deepEqual(initB.result, initA.result, "b gets the cached initialize result");
  b.open(badUri, fs.readFileSync(new URL(badUri), "utf8"));
  await b.diagnosticsFor(badUri, hasTypeError);

  const status = readStatus();
  assert.equal(status.clients, 2);
  assert.ok(isAlive(status.backendPid), "one live backend");

  // a leaves; b keeps working on the same backend.
  assert.equal(await a.close(), 0);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(readStatus().clients, 1);
  assert.equal(readStatus().backendPid, status.backendPid);

  const fixed = "export const n: number = 1;\n";
  fs.writeFileSync(new URL(badUri), fixed);
  b.messages.length = 0;
  b.notify("textDocument/didChange", { textDocument: { uri: badUri, version: 2 }, contentChanges: [{ text: fixed }] });
  await b.diagnosticsFor(badUri, (d) => d.length === 0);

  // b leaves; the daemon exits once idle (TSD_IDLE_MS = 1500).
  assert.equal(await b.close(), 0);
  const deadline = Date.now() + 15000;
  while (fs.existsSync(statusFile(rootKey(project))) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  assert.equal(fs.existsSync(statusFile(rootKey(project))), false, "daemon cleaned up after idling");
  assert.equal(isAlive(status.daemonPid), false);
  assert.equal(isAlive(status.backendPid), false);
});

test("a session that dies without saying goodbye is detached", { skip, timeout: 120000 }, async () => {
  const a = startSession();
  await a.initialize();
  const b = startSession();
  await b.initialize();
  assert.equal(readStatus().clients, 2);
  b.child.kill();
  await b.exited;
  const deadline = Date.now() + 5000;
  while (readStatus().clients !== 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(readStatus().clients, 1);
  await a.close();
});

test("sessions starting together end up on one daemon (over a crashed daemon's socket on unix)", { skip, timeout: 120000 }, async () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "tsd-it-race-"));
  const endpoint = endpointFor(rootKey(other));
  if (process.platform !== "win32") {
    // Leave a socket file with nobody behind it, the way a SIGKILLed daemon does.
    const holder = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(endpoint)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve) => holder.stdout.once("data", resolve));
    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.on("exit", resolve));
    assert.ok(fs.existsSync(endpoint), "stale socket left behind");
  }
  const params = { processId: process.pid, rootUri: pathToFileURL(other).href, capabilities: {} };
  const group = [startSession(), startSession(), startSession()];
  try {
    const answers = await Promise.all(group.map((s) => s.request("initialize", params)));
    for (const a of answers) assert.ok(a.result?.capabilities);
    const status = JSON.parse(fs.readFileSync(statusFile(rootKey(other)), "utf8"));
    assert.equal(status.clients, 3, "all three on the same daemon");
    for (const s of group) { await s.request("shutdown", null); s.notify("exit", null); await s.exited; }
    process.kill(status.daemonPid);
  } finally {
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("a daemon that hangs up before answering costs nothing: the shim runs the server itself", { skip, timeout: 120000 }, async () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "tsd-it-hangup-"));
  // Stands in for a daemon whose backend died during initialize.
  const liar = net.createServer((sock) => sock.destroy());
  await new Promise((resolve) => liar.listen(endpointFor(rootKey(other)), resolve));
  try {
    const s = startSession();
    const res = await s.request("initialize", { processId: process.pid, rootUri: pathToFileURL(other).href, capabilities: {} });
    assert.ok(res.result?.capabilities, "initialize answered by the fallback server");
    s.notify("initialized", {});
    await s.request("shutdown", null);
    s.notify("exit", null);
    await s.exited;
  } finally {
    liar.close();
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("TSD_DISABLE runs the real server directly", { skip, timeout: 120000 }, async () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "tsd-it-direct-"));
  try {
    const s = startSession({ TSD_DISABLE: "1" });
    const res = await s.request("initialize", { processId: process.pid, rootUri: pathToFileURL(other).href, capabilities: {} });
    assert.ok(res.result?.capabilities);
    assert.equal(fs.existsSync(statusFile(rootKey(other))), false, "no daemon for this root");
    s.notify("initialized", {});
    await s.request("shutdown", null);
    s.notify("exit", null);
    await s.exited;
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});
