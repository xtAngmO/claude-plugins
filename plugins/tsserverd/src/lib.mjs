// lib.mjs — LSP framing, the per-root endpoint name, and the shared runtime dir.
// Imported by the shim (what Claude Code spawns), the daemon (the broker process)
// and the CLI, so all three agree on where a root's daemon lives.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const IS_WINDOWS = process.platform === "win32";

// Windows paths are case-insensitive, and Claude Code does not always spell the
// drive letter the same way (`c:\…` in one session, `C:\…` in the next). Folding
// before hashing is what lets two sessions in one folder find the same daemon.
export function normalizeRoot(root) {
  const resolved = path.resolve(String(root));
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

// Short stable key for a root. The user name is mixed in so two accounts on one
// machine never share a daemon, and TSD_NAMESPACE lets tests run beside a live one.
export function rootKey(root) {
  let user = "";
  try { user = os.userInfo().username; } catch {}
  const ns = process.env.TSD_NAMESPACE || "";
  return createHash("sha1").update(`${user}\0${ns}\0${normalizeRoot(root)}`).digest("hex").slice(0, 16);
}

export function runDir() {
  return process.env.TSD_RUN_DIR || path.join(os.tmpdir(), "tsserverd");
}

export function ensureRunDir() {
  const dir = runDir();
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  return dir;
}

// Where a root's daemon listens. Windows cannot listen on a file path — libuv
// wants a named pipe there — which is why the upstream `.sock` file never came up
// on Windows and every session quietly fell back to its own tsserver.
export function endpointFor(key) {
  if (IS_WINDOWS) return `\\\\.\\pipe\\tsserverd-${key}`;
  return path.join(runDir(), `${key}.sock`);
}

export function statusFile(key) {
  return path.join(runDir(), `${key}.status.json`);
}

// Streaming Content-Length reader. One per stream: it keeps its own buffer.
export function createReader(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buf.subarray(0, headerEnd).toString("ascii");
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) { buf = buf.subarray(headerEnd + 4); continue; }
      const start = headerEnd + 4;
      const end = start + Number(m[1]);
      if (buf.length < end) return;
      const body = buf.subarray(start, end).toString("utf8");
      buf = buf.subarray(end);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      onMessage(msg);
    }
  };
}

export function encode(msg) {
  const json = Buffer.from(JSON.stringify(msg), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, "ascii"), json]);
}

// Lifecycle lines only, never per-message traffic: this file is shared by every
// shim and daemon on the machine. Rolled over once it passes 2 MB.
const LOG_MAX_BYTES = 2 * 1024 * 1024;
export function createLogger(tag) {
  const file = process.env.TSD_LOG || path.join(ensureRunDir(), "tsserverd.log");
  try {
    if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {}
  return (...parts) => {
    try { fs.appendFileSync(file, `[${new Date().toISOString()}][${tag} ${process.pid}] ${parts.join(" ")}\n`); } catch {}
  };
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
