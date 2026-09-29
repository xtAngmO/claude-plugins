// live.mjs — tells other programs on this machine which browser is whose.
//
// While a browser server runs, <CDP_HOME>/live/<pid>.json (pid = this plugin
// process) says which Claude Code session owns it and which profile its Chrome
// runs on. A program that shows the user what a session's browser is doing
// reads it, then attaches to the port in <profileDir>/DevToolsActivePort.
//
// The file exists only while a server does: written when one starts, removed
// when it stops (idle close, crash, visibility switch, session end). A process
// killed outright cannot remove its own, so a reader checks that `pid` is
// alive, and every write here sweeps the files of processes that are gone.
import fs from "node:fs";
import path from "node:path";

export const LIVE_VERSION = 1;

function defaultPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// Claude Code sets CLAUDE_PID for the processes it starts; without it, the
// parent is the best guess (Claude Code starts MCP servers directly).
export function claudePidOf(env = process.env, ppid = process.ppid) {
  const n = Number(env.CLAUDE_PID);
  return Number.isInteger(n) && n > 0 ? n : ppid;
}

export function createLive({
  home,
  pid = process.pid,
  claudePid = claudePidOf(),
  sessionId = process.env.CLAUDE_CODE_SESSION_ID || null,
  project = null,
  now = () => Date.now(),
  pidAlive = defaultPidAlive,
  log = () => {},
}) {
  const dir = path.join(home, "live");
  const file = path.join(dir, `${pid}.json`);

  // Files left by plugin processes that were killed before they could remove them.
  function sweep() {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const m = /^(\d+)\.json$/.exec(name);
      if (!m || Number(m[1]) === pid || pidAlive(Number(m[1]))) continue;
      try { fs.rmSync(path.join(dir, name), { force: true }); } catch {}
    }
  }

  return {
    file,

    // → the record written, or null when it could not be.
    write({ slot = null, profileDir = null, headless = false }) {
      const record = {
        version: LIVE_VERSION,
        pid,
        claudePid,
        sessionId,
        slot,
        profileDir: profileDir && path.resolve(profileDir),
        project,
        headless: Boolean(headless),
        startedAt: now(),
      };
      // Written whole and renamed into place, so a reader never sees half a file.
      const tmp = `${file}.tmp`;
      try {
        fs.mkdirSync(dir, { recursive: true });
        sweep();
        fs.writeFileSync(tmp, JSON.stringify(record));
        fs.renameSync(tmp, file);
        return record;
      } catch (e) {
        log(`could not write ${file}: ${e.message}`);
        try { fs.rmSync(tmp, { force: true }); } catch {}
        return null;
      }
    },

    // Synchronous, so it also works from a process 'exit' handler.
    remove() {
      try { fs.rmSync(file, { force: true }); } catch {}
    },
  };
}
