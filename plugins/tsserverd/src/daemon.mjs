// daemon.mjs — one per project root. Listens on the root's endpoint, owns one
// typescript-language-server, and puts every session that connects through the
// Broker. Exits 10 minutes (TSD_IDLE_MS) after the last session leaves, or as
// soon as the backend dies — the shims then exit and Claude Code restarts them.
//
//   node daemon.mjs --launch <root> [backend args…]   start detached, return at once
//   node daemon.mjs <root> [backend args…]            be the daemon
import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Broker } from "./broker.mjs";
import { resolveBackend, spawnBackend } from "./backend.mjs";
import {
  IS_WINDOWS, createLogger, createReader, encode, endpointFor, ensureRunDir, rootKey, statusFile,
} from "./lib.mjs";

const SELF = fileURLToPath(import.meta.url);

// Launch through one throwaway hop so the daemon's parent is a process that has
// already exited. A session that kills its LSP server by process tree then
// cannot reach the daemon every other session is using.
if (process.argv[2] === "--launch") {
  spawn(process.execPath, [SELF, ...process.argv.slice(3)], {
    detached: true, stdio: "ignore", windowsHide: true,
  }).unref();
  process.exit(0);
}

const [, , ROOT, ...BACKEND_ARGS] = process.argv;
if (!ROOT) process.exit(2);

const DEFAULT_TSSERVER_MEMORY_MB = 12288;
const positiveInt = (v) => (/^\d+$/.test(String(v ?? "")) && Number(v) > 0 ? Number(v) : undefined);
const IDLE_MS = positiveInt(process.env.TSD_IDLE_MS) ?? 10 * 60 * 1000;
const MEMORY_OVERRIDE = positiveInt(process.env.TSD_MAX_TSSERVER_MEMORY);

ensureRunDir();
const log = createLogger("daemon");
const KEY = rootKey(ROOT);
const ENDPOINT = endpointFor(KEY);
const STATUS = statusFile(KEY);
const startedAt = new Date().toISOString();

let server = null;
let backend = null;
let backendSpec = null;
let idleTimer = null;
let stopping = false;
let peakClients = 0;

const broker = new Broker({
  toBackend: (msg) => {
    if (backend?.stdin.writable) backend.stdin.write(encode(msg));
  },
  log,
  processId: process.pid,
  memoryOverride: MEMORY_OVERRIDE,
  memoryDefault: DEFAULT_TSSERVER_MEMORY_MB,
  onEmpty: () => { writeStatus(); scheduleIdleExit(); },
  onInitFailed: () => stop(1),
});

function writeStatus() {
  if (stopping) return;
  const status = {
    root: ROOT,
    key: KEY,
    endpoint: ENDPOINT,
    daemonPid: process.pid,
    backendPid: backend?.pid ?? null,
    backend: backendSpec?.describe ?? null,
    clients: broker.clientCount,
    peakClients,
    openDocuments: broker.openDocumentCount,
    maxTsServerMemory: MEMORY_OVERRIDE ?? DEFAULT_TSSERVER_MEMORY_MB,
    startedAt,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${STATUS}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2));
    fs.renameSync(tmp, STATUS);
  } catch (e) {
    log("could not write status:", e.message);
  }
}

function scheduleIdleExit() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (broker.clientCount === 0) { log("idle for", IDLE_MS, "ms; exiting"); stop(0); }
  }, IDLE_MS);
}

function startBackend() {
  backendSpec = resolveBackend(BACKEND_ARGS);
  if (!backendSpec) { log("typescript-language-server not found on PATH"); stop(1); return; }
  try {
    backend = spawnBackend(backendSpec, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    log("could not start backend:", e.message);
    stop(1);
    return;
  }
  backend.on("error", (e) => { log("backend error:", e.message); stop(1); });
  backend.on("exit", (code, signal) => { log("backend exited", code ?? signal); stop(code ? 1 : 0); });
  backend.stdin.on("error", () => {});
  backend.stdout.on("data", createReader((msg) => broker.fromBackend(msg)));
  backend.stderr.on("data", (d) => log("backend:", String(d).trim().slice(0, 500)));
  log("backend", backend.pid, "=", backendSpec.describe, "cwd", ROOT);
}

function onConnection(sock) {
  if (stopping) { sock.destroy(); return; }
  clearTimeout(idleTimer);
  const client = broker.addClient(
    (msg) => { if (!sock.destroyed) sock.write(encode(msg)); },
    () => sock.end(),
  );
  peakClients = Math.max(peakClients, broker.clientCount);
  log("session", client.id, "joined;", broker.clientCount, "attached");
  writeStatus();
  sock.on("data", createReader((msg) => broker.fromClient(client, msg)));
  sock.on("error", () => {});
  sock.on("close", () => { broker.removeClient(client); writeStatus(); });
}

function listen(retried = false) {
  server = net.createServer(onConnection);
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE" && !IS_WINDOWS && !retried) {
      // A socket file nobody answers on is a daemon that crashed; take its place.
      const probe = net.connect(ENDPOINT);
      probe.once("connect", () => { probe.destroy(); log("another daemon already serves", ROOT); process.exit(0); });
      probe.once("error", () => { try { fs.unlinkSync(ENDPOINT); } catch {} listen(true); });
      return;
    }
    // Losing this race is normal: several shims can launch at once.
    log(e.code === "EADDRINUSE" ? "another daemon already serves" : `listen failed: ${e.message}`, ROOT);
    process.exit(0);
  });
  // The endpoint is the lock: the backend starts only once we own it, so the
  // daemons that lose the race never cost a tsserver.
  server.listen(ENDPOINT, () => {
    if (!IS_WINDOWS) { try { fs.chmodSync(ENDPOINT, 0o600); } catch {} }
    log("listening on", ENDPOINT, "for", ROOT);
    startBackend();
    writeStatus();
    scheduleIdleExit(); // in case the shim that launched us is already gone
  });
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(idleTimer);
  try { server?.close(); } catch {}
  if (!IS_WINDOWS) { try { fs.unlinkSync(ENDPOINT); } catch {} }
  try { fs.unlinkSync(STATUS); } catch {}
  if (!backend || backend.exitCode !== null || backend.signalCode !== null) process.exit(code);
  backend.once("exit", () => process.exit(code));
  try {
    backend.stdin.write(encode({ jsonrpc: "2.0", id: "tsserverd-shutdown", method: "shutdown" }));
    backend.stdin.write(encode({ jsonrpc: "2.0", method: "exit" }));
  } catch {}
  setTimeout(() => { try { backend.kill(); } catch {} process.exit(code); }, 2000);
}

process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
process.on("uncaughtException", (e) => { log("crash:", e.stack ?? e.message); stop(1); });

listen();
