// slots.mjs — one Chrome profile per running browser, never two browsers on one.
//
// chrome-devtools-mcp defaults every client to one user-data-dir, and Chrome lets
// a single browser hold a profile, so the second session to open a browser got
// an empty DevToolsActivePort and failed at random. Pointing everyone at one
// browser instead (--browserUrl) mixes sessions: shared tabs, shifting
// list_pages indices, one session's new_page stealing the other's selection.
//
// So each browser claims a numbered SLOT, a persistent profile guarded by a
// pid-owned lock. The lock files are the same ones the standalone
// cdp-slot-chrome.mjs wrapper uses (Codex still runs it), so both coordinate.
//
// Slots remember which project last used them. A project gets its own profile
// back when that slot is free, so a site it signed in to stays signed in, and a
// new project takes an unclaimed slot before it borrows another project's.
import fs from "node:fs";
import path from "node:path";

function defaultPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// A running Chrome keeps an exclusive handle on the profile's lockfile, so
// failing to open it means some other browser owns this profile right now.
function defaultProfileBusy(profile) {
  const lock = path.join(profile, "lockfile");
  if (!fs.existsSync(lock)) return false;
  try {
    fs.closeSync(fs.openSync(lock, "r+"));
    return false;
  } catch (e) {
    return e.code === "EBUSY" || e.code === "EPERM" || e.code === "EACCES";
  }
}

// A browser that crashed leaves these behind, and they block the next launch.
function clearStaleLocks(profile) {
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try { fs.rmSync(path.join(profile, name), { force: true, recursive: true }); } catch {}
  }
}

export function createSlots({
  home,
  maxSlots = 8,
  project = null,
  log = () => {},
  pidAlive = defaultPidAlive,
  profileBusy = defaultProfileBusy,
  now = () => Date.now(),
  pid = process.pid,
}) {
  const dir = path.join(home, "slots");
  const lockOf = (n) => path.join(dir, `slot-${n}.lock`);
  const metaOf = (n) => path.join(dir, `slot-${n}.json`);
  // Slot 1 is the profile chrome-devtools-mcp used before slots existed, so
  // whatever was signed in there keeps working.
  const profileOf = (n) => (n === 1 ? path.join(home, "chrome-profile") : path.join(home, `profile-${n}`));

  const readMeta = (n) => {
    try { return JSON.parse(fs.readFileSync(metaOf(n), "utf8")); } catch { return null; }
  };

  function lock(n) {
    try {
      fs.writeFileSync(lockOf(n), String(pid), { flag: "wx" });
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") return false;
      try {
        const holder = Number(fs.readFileSync(lockOf(n), "utf8").trim());
        if (holder === pid) return true;
        if (holder && pidAlive(holder)) return false;
        // Its holder was killed without cleaning up.
        fs.rmSync(lockOf(n), { force: true });
        fs.writeFileSync(lockOf(n), String(pid), { flag: "wx" });
        return true;
      } catch {
        return false;
      }
    }
  }

  function unlock(n) {
    try {
      if (fs.readFileSync(lockOf(n), "utf8").trim() === String(pid)) fs.rmSync(lockOf(n), { force: true });
    } catch {}
  }

  // This project's slots first, then slots nobody has claimed for a project,
  // then the ones used longest ago.
  function order() {
    const slots = Array.from({ length: maxSlots }, (_, i) => ({ n: i + 1, meta: readMeta(i + 1) }));
    const rank = (s) => (project && s.meta?.project === project ? 0 : s.meta?.project ? 2 : 1);
    return slots
      .sort((a, b) => rank(a) - rank(b) || (a.meta?.lastUsed ?? 0) - (b.meta?.lastUsed ?? 0) || a.n - b.n)
      .map((s) => s.n);
  }

  return {
    profileOf,

    // → { slot, profile } or null when every slot is taken.
    claim() {
      fs.mkdirSync(dir, { recursive: true });
      for (const n of order()) {
        if (!lock(n)) continue;
        const profile = profileOf(n);
        if (profileBusy(profile)) {
          log(`slot ${n}: profile held by another browser, trying the next one`);
          unlock(n);
          continue;
        }
        clearStaleLocks(profile);
        try { fs.writeFileSync(metaOf(n), JSON.stringify({ project, lastUsed: now() })); } catch {}
        log(`slot ${n}: ${profile}${project ? ` (for ${project})` : ""}`);
        return { slot: n, profile };
      }
      return null;
    },

    release(n) {
      if (!n) return;
      try { fs.writeFileSync(metaOf(n), JSON.stringify({ project, lastUsed: now() })); } catch {}
      unlock(n);
    },
  };
}
