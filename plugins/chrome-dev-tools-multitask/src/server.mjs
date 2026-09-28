// server.mjs — find, start and stop the real chrome-devtools-mcp.
//
// Once npx has fetched a version, its entry script is run with the node that
// is already running us: no npx process kept alive as a parent, and no usage
// statistics, which is what starts the telemetry watchdog. The official plugin
// runs three node processes per session; this is one.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IS_WINDOWS = process.platform === "win32";

function splitSpec(spec) {
  const at = spec.lastIndexOf("@");
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec, version: "latest" };
}

function npxCacheDirs() {
  const dirs = [];
  if (process.env.npm_config_cache) dirs.push(path.join(process.env.npm_config_cache, "_npx"));
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, "npm-cache", "_npx"));
  dirs.push(path.join(os.homedir(), ".npm", "_npx"));
  return dirs;
}

// The package's entry script in npx's cache, if that exact version is there.
export function cachedEntry(spec) {
  const { name, version } = splitSpec(spec);
  if (version === "latest") return null; // "latest" cannot be matched without asking npm
  for (const dir of npxCacheDirs()) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      const pkgDir = path.join(dir, entry, "node_modules", ...name.split("/"));
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
        if (pkg.version !== version) continue;
        const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[name.split("/").pop()] ?? Object.values(pkg.bin ?? {})[0];
        const script = rel && path.join(pkgDir, rel);
        if (script && fs.existsSync(script)) return script;
      } catch {}
    }
  }
  return null;
}

// npm ships npx as a .cmd shim that Node >= 20 will not spawn without a shell;
// npx-cli.js run with our own node needs none.
function npxCli() {
  return [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"),
    path.join(process.env.APPDATA ?? "", "npm", "node_modules", "npm", "bin", "npx-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
  ].find((p) => p && fs.existsSync(p));
}

// → { command, args, shell, via }
export function serverCommand(spec, args) {
  const entry = cachedEntry(spec);
  if (entry) return { command: process.execPath, args: [entry, ...args], shell: false, via: entry };
  const cli = npxCli();
  if (cli) return { command: process.execPath, args: [cli, "--yes", spec, ...args], shell: false, via: "npx" };
  return { command: "npx", args: ["--yes", spec, ...args], shell: true, via: "npx (shell)" };
}

export function startServer({ spec, args, onMessageChunk, onExit, log }) {
  const cmd = serverCommand(spec, args);
  log(`starting ${spec} via ${cmd.via}`);
  const child = spawn(cmd.command, cmd.args, { stdio: ["pipe", "pipe", "pipe"], shell: cmd.shell, windowsHide: true });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", onMessageChunk);
  // Its stderr is diagnostics; ours goes to the same place, the MCP client's log.
  child.stderr.on("data", (d) => process.stderr.write(d));
  child.stdin.on("error", () => {});
  let exited = false;
  child.on("exit", (code, signal) => { exited = true; onExit(code, signal); });
  child.on("error", (e) => { log(`could not start: ${e.message}`); if (!exited) { exited = true; onExit(1, null); } });
  return {
    pid: child.pid,
    write: (line) => { if (child.stdin.writable) child.stdin.write(line); },
    // Closing stdin is the polite stop: the server shuts its browser and exits.
    stop: () => new Promise((resolve) => {
      if (exited) { resolve(); return; }
      child.once("exit", () => resolve());
      try { child.stdin.end(); } catch {}
      setTimeout(() => { if (!exited) { try { child.kill(); } catch {} } }, 5000).unref();
    }),
  };
}

// A browser left running on a profile would make that slot unusable. Normally
// the server closes it on the way out; this is the backstop for a server that
// was killed first.
export function killBrowsersOn(profile, log = () => {}) {
  if (!profile) return 0;
  const needle = IS_WINDOWS ? profile.toLowerCase() : profile;
  let rows = [];
  try {
    if (IS_WINDOWS) {
      const script = "$ProgressPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='chrome-headless-shell.exe'\" | ForEach-Object { \"{0}`t{1}\" -f $_.ProcessId, $_.CommandLine }";
      rows = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
        .split(/\r?\n/).filter(Boolean).map((l) => { const [pid, ...cmd] = l.split("\t"); return { pid: Number(pid), cmd: cmd.join("\t") }; });
    } else {
      rows = execFileSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" })
        .split("\n").map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), cmd: m[2] }));
    }
  } catch {
    return 0;
  }
  let killed = 0;
  for (const r of rows) {
    const cmd = IS_WINDOWS ? r.cmd.toLowerCase() : r.cmd;
    if (!cmd.includes(`--user-data-dir=${needle}`) && !cmd.includes(`--user-data-dir="${needle}"`)) continue;
    try { process.kill(r.pid); killed++; } catch {}
  }
  if (killed) log(`closed ${killed} leftover browser process(es) on ${profile}`);
  return killed;
}
