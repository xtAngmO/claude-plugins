// shim.mjs — what Claude Code spawns (see .lsp.json). It speaks LSP on stdio the
// way typescript-language-server does, reads `initialize` to learn the session's
// root, and bridges stdio to that root's daemon, launching one if none answers.
//
// If anything on that path fails it runs the real server itself and replays what
// it has already read, so a broken daemon costs memory, never LSP.
//
//   TSD_DISABLE=1   skip the daemon entirely: behave exactly like the real server
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveBackend, spawnBackend } from "./backend.mjs";
import { createLogger, createReader, encode, endpointFor, isAlive, rootKey } from "./lib.mjs";

const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.mjs");
const ARGS = process.argv.slice(2);
const INITIALIZE_WAIT_MS = 5000;
const CONNECT_WAIT_MS = 8000;
const log = createLogger("shim");

let mode = "waiting"; // waiting → connecting → connected | direct
let sock = null;
let direct = null;
let exiting = false;  // the session is leaving; a closed socket is expected now
const buffered = [];  // read before we knew where to send it; replayed in order

if (process.env.TSD_DISABLE) {
  runDirect("TSD_DISABLE is set", true);
} else {
  const read = createReader(onSessionMessage);
  process.stdin.on("data", read);
  process.stdin.on("end", onSessionEnd);
  process.stdin.on("error", onSessionEnd);
  setTimeout(() => { if (mode === "waiting") runDirect("no initialize within 5s"); }, INITIALIZE_WAIT_MS).unref();
}

function onSessionMessage(msg) {
  if (msg?.method === "exit") exiting = true;
  if (mode === "connected") { sock.write(encode(msg)); return; }
  if (mode === "direct") { direct.stdin.write(encode(msg)); return; }
  buffered.push(msg);
  if (mode === "waiting" && msg?.method === "initialize") begin(msg);
}

function onSessionEnd() {
  exiting = true;
  if (mode === "connected") sock.end();
  else if (mode === "direct") direct.stdin.end();
  else process.exit(0);
}

function rootOf(params = {}) {
  const uri = params.rootUri ?? params.workspaceFolders?.[0]?.uri;
  if (uri) { try { return fileURLToPath(uri); } catch {} }
  return params.rootPath || process.cwd();
}

function begin(init) {
  mode = "connecting";
  watchSession(init.params?.processId);
  const root = rootOf(init.params ?? {});
  const endpoint = endpointFor(rootKey(root));
  connect(root, endpoint, Date.now(), false);
}

// The daemon no longer tells the backend who our session is, so the shim is the
// one that notices when the session dies without saying goodbye.
function watchSession(pid) {
  if (!Number.isInteger(pid)) return;
  setInterval(() => {
    if (isAlive(pid)) return;
    log("session", pid, "is gone");
    exiting = true;
    process.exit(0);
  }, 5000).unref();
}

function connect(root, endpoint, since, launched) {
  const s = net.connect(endpoint);
  s.once("connect", () => {
    if (mode !== "connecting") { s.destroy(); return; }
    onConnected(s);
  });
  s.once("error", () => {
    s.destroy();
    if (mode !== "connecting") return;
    if (!launched) launchDaemon(root);
    if (Date.now() - since > CONNECT_WAIT_MS) { runDirect("daemon did not come up"); return; }
    setTimeout(() => connect(root, endpoint, since, true), 100);
  });
}

function launchDaemon(root) {
  try {
    spawn(process.execPath, [DAEMON, "--launch", root, ...ARGS], {
      detached: true, stdio: "ignore", windowsHide: true,
    }).unref();
    log("launched daemon for", root);
  } catch (e) {
    log("could not launch daemon:", e.message);
  }
}

function onConnected(s) {
  sock = s;
  mode = "connected";
  for (const msg of buffered.splice(0)) s.write(encode(msg));
  s.on("data", (d) => process.stdout.write(d));
  s.on("error", () => {});
  s.on("close", () => {
    if (!exiting) log("daemon went away mid-session; exiting so Claude Code restarts LSP");
    process.exit(exiting ? 0 : 1);
  });
}

function runDirect(reason, passthrough = false) {
  if (mode === "direct") return;
  const spec = resolveBackend(ARGS);
  log("running typescript-language-server directly:", reason);
  if (!spec) { log("typescript-language-server not found on PATH"); process.exit(1); }
  mode = "direct";
  if (sock) { sock.destroy(); sock = null; }
  direct = spawnBackend(spec, { stdio: passthrough ? "inherit" : ["pipe", "inherit", "inherit"] });
  direct.on("exit", (code) => process.exit(code ?? 0));
  direct.on("error", (e) => { log("could not start it:", e.message); process.exit(1); });
  if (passthrough) return;
  direct.stdin.on("error", () => {});
  for (const msg of buffered.splice(0)) direct.stdin.write(encode(msg));
}
