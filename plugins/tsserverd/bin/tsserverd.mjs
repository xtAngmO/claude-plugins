#!/usr/bin/env node
// tsserverd — inspect the shared TypeScript language servers.
//
//   node bin/tsserverd.mjs status   daemons, sessions attached, memory, and any
//                                   tsserver still running outside tsserverd
//   node bin/tsserverd.mjs doctor   which typescript-language-server would run
//   node bin/tsserverd.mjs stop     stop every daemon (sessions restart LSP)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveBackend } from "../src/backend.mjs";
import { IS_WINDOWS, isAlive, runDir } from "../src/lib.mjs";

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

// A killed daemon never removes its status file, and the temp dir survives a
// reboot, so a recorded pid can belong to anything by now. Trust it only while
// that pid is still running our daemon.mjs; without a process table (the OS
// would not say), fall back to "the pid exists".
function isOurDaemon(pid, procs) {
  if (!procs.length) return isAlive(pid);
  return procs.some((p) => p.pid === pid && /daemon\.mjs/i.test(p.cmd));
}

function readStatuses(procs) {
  let files = [];
  try { files = fs.readdirSync(runDir()).filter((f) => f.endsWith(".status.json")); } catch { return []; }
  const live = [];
  for (const f of files) {
    const file = path.join(runDir(), f);
    try {
      const s = JSON.parse(fs.readFileSync(file, "utf8"));
      if (isOurDaemon(s.daemonPid, procs)) live.push(s);
      else fs.unlinkSync(file);
    } catch {}
  }
  return live;
}

// [{ pid, ppid, bytes, cmd }] for every process, or [] if the OS will not say.
function processTable() {
  try {
    if (IS_WINDOWS) {
      // -EncodedCommand: quotes passed through argv to powershell.exe are mangled.
      const script = "$ProgressPreference = 'SilentlyContinue'; Get-CimInstance Win32_Process | ForEach-Object { \"{0}`t{1}`t{2}`t{3}\" -f $_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, ($_.CommandLine -replace '\\s+', ' ') }";
      const out = execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
      ], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
      return out.split(/\r?\n/).filter(Boolean).map((line) => {
        const [pid, ppid, bytes, ...cmd] = line.split("\t");
        return { pid: Number(pid), ppid: Number(ppid), bytes: Number(bytes) || 0, cmd: cmd.join("\t") };
      });
    }
    const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return out.split("\n").filter(Boolean).map((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), bytes: Number(m[3]) * 1024, cmd: m[4] } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function treeOf(rootPid, procs) {
  const children = new Map();
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const out = [];
  const stack = procs.filter((p) => p.pid === rootPid);
  while (stack.length) {
    const p = stack.pop();
    out.push(p);
    stack.push(...(children.get(p.pid) ?? []));
  }
  return out;
}

const isTsserver = (p) => /tsserver\.js/i.test(p.cmd) && !/typingsInstaller/i.test(p.cmd);

function status() {
  const procs = processTable();
  const daemons = readStatuses(procs);
  const owned = new Set();
  let sharedBytes = 0;

  if (daemons.length === 0) console.log("No tsserverd daemon running. They start when a session first opens a TS/JS file.");
  for (const s of daemons) {
    const tree = s.backendPid ? treeOf(s.backendPid, procs) : [];
    for (const p of tree) owned.add(p.pid);
    const bytes = tree.reduce((sum, p) => sum + p.bytes, 0);
    sharedBytes += bytes;
    console.log(`${s.root}`);
    console.log(`  sessions ${s.clients} now · ${s.peakClients} at peak · ${s.openDocuments} open files`);
    console.log(`  daemon ${s.daemonPid} · backend ${s.backendPid ?? "-"} · ${procs.length ? gb(bytes) : "memory unknown"} · cap ${s.maxTsServerMemory} MB per tsserver · since ${s.startedAt}`);
  }

  if (!procs.length) return;
  const outside = procs.filter((p) => isTsserver(p) && !owned.has(p.pid));
  const outsideBytes = outside.reduce((sum, p) => sum + p.bytes, 0);
  console.log("");
  console.log(`tsserver under tsserverd: ${gb(sharedBytes)}`);
  console.log(`tsserver outside tsserverd: ${outside.length} process(es), ${gb(outsideBytes)}`);
  if (outside.length) console.log("  (sessions started before tsserverd, or with the old typescript-lsp plugin — close them to free this)");
}

function doctor() {
  const spec = resolveBackend(["--stdio"]);
  console.log(`node        ${process.execPath} (${process.version})`);
  console.log(`runtime dir ${runDir()}`);
  if (!spec) {
    console.log("backend     NOT FOUND — install it: npm i -g typescript-language-server typescript@6");
    process.exitCode = 1;
    return;
  }
  console.log(`backend     ${spec.describe}${spec.shell ? " (through a shell)" : ""}`);
}

function stop() {
  const daemons = readStatuses(processTable());
  for (const s of daemons) {
    try { process.kill(s.daemonPid, "SIGTERM"); console.log(`stopped ${s.root} (daemon ${s.daemonPid})`); } catch {}
  }
  if (!daemons.length) console.log("No tsserverd daemon running.");
}

const command = process.argv[2] ?? "status";
const commands = { status, doctor, stop };
if (!commands[command]) {
  console.error(`unknown command "${command}" — use status, doctor or stop`);
  process.exit(2);
}
commands[command]();
