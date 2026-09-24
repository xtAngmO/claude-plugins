// backend.mjs — find and start the real typescript-language-server.
//
// Resolution prefers the package's own entry script, run with the node that is
// already running us. That sidesteps the two Windows launchers npm leaves on
// PATH: `typescript-language-server` (a sh script that CreateProcess cannot run)
// and `typescript-language-server.cmd` (which Node refuses to spawn without a
// shell since CVE-2024-27980). Upstream picked the sh script, so on Windows even
// its fallback path died.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { IS_WINDOWS } from "./lib.mjs";

const PKG = "typescript-language-server";

// npm on Windows installs packages next to the launcher (<prefix>/node_modules);
// npm elsewhere uses <prefix>/lib/node_modules beside <prefix>/bin; bun keeps
// global packages under ~/.bun/install/global.
function packageDirsFor(binDir) {
  return [
    path.join(binDir, "node_modules", PKG),
    path.join(binDir, "..", "lib", "node_modules", PKG),
    path.join(binDir, "..", "install", "global", "node_modules", PKG),
  ];
}

function entryScriptOf(pkgDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[PKG];
    if (!rel) return null;
    const script = path.join(pkgDir, rel);
    return fs.existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function fromExplicit(p, args) {
  if (/\.[cm]?js$/i.test(p)) return { command: process.execPath, args: [p, ...args], shell: false, describe: p };
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(p)) return { command: p, args, shell: true, describe: p };
  return { command: p, args, shell: false, describe: p };
}

// Returns { command, args, shell, describe } or null when nothing is installed.
export function resolveBackend(args, env = process.env) {
  if (env.TSD_REAL_TLS) return fromExplicit(env.TSD_REAL_TLS, args);

  const dirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const pkgDir of packageDirsFor(dir)) {
      const script = entryScriptOf(pkgDir);
      if (script) return { command: process.execPath, args: [script, ...args], shell: false, describe: script };
    }
  }
  // Last resort: whatever launcher PATH offers.
  for (const dir of dirs) {
    if (IS_WINDOWS) {
      const cmd = path.join(dir, `${PKG}.cmd`);
      if (isFile(cmd)) return { command: cmd, args, shell: true, describe: cmd };
    } else {
      const bin = path.join(dir, PKG);
      if (isFile(bin)) return { command: bin, args, shell: false, describe: bin };
    }
  }
  return null;
}

export function spawnBackend(spec, options = {}) {
  return spawn(spec.command, spec.args, { ...options, shell: spec.shell, windowsHide: true });
}
