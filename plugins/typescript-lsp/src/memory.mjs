// memory.mjs — how much memory the machine has left, and how much heap each
// project's tsserver may use. Imported by the shim and the daemon.
//
// Two policies:
//   * Pressure. When available memory runs low, a session lets go of the
//     projects it is not using sooner (router.tick), and a daemon nobody is
//     attached to exits sooner (daemon.mjs). Both are ordinary releases, so the
//     session's link never counts them as failures.
//   * Heap cap. Every tsserver starts with DEFAULT_TSSERVER_MEMORY_MB. With a
//     12 GB cap V8 let garbage pile up: one tsserver measured 6.7 GB and, a
//     minute later and still the same process, 2.9 GB. A project whose tsserver
//     dies is given twice its cap the next time (learnCap), up to CAP_CEILING_MB,
//     so a lower default cannot lock a big project out of LSP.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDir } from "./lib.mjs";

// 1.5 × the largest live heap measured on real repos (4.15–4.3 GB: 6,227 files,
// every one type-checked, then checked again after an edit). At this cap that
// project peaked at 5.4 GB of private memory instead of 8.0 GB, with no slower
// checks and GC pauses of 12–60 ms.
export const DEFAULT_TSSERVER_MEMORY_MB = 6656;
export const CAP_CEILING_MB = 12288;

const MB = 1024 * 1024;
const count = (v) => (/^\d+$/.test(String(v ?? "")) ? Number(v) : undefined);

// Available memory below this many MB counts as pressure. 0 turns it off.
// os.freemem() is "available" memory on Windows and MemAvailable on Linux. On
// macOS it counts only pages nobody uses (the file cache is left out), so it
// reads low on a healthy machine: there pressure is opt-in.
export function pressureThresholdMB({ env = process.env, platform = process.platform, totalmem = os.totalmem } = {}) {
  const set = count(env.TSD_PRESSURE_FREE_MB);
  if (set !== undefined) return set;
  if (platform === "darwin") return 0;
  return Math.min(8192, Math.floor(totalmem() / 8 / MB));
}

export function underPressure({ env, platform, totalmem, freemem = os.freemem } = {}) {
  const threshold = pressureThresholdMB({ env, platform, totalmem });
  return threshold > 0 && freemem() < threshold * MB;
}

// The cap a project's tsserver starts with: whatever was asked for, but never
// less than what this project needed before.
export function effectiveCap(asked, learned) {
  return learned ? Math.max(asked, learned) : asked;
}

export function nextCap(mb) {
  return Math.min(CAP_CEILING_MB, mb * 2);
}

const capFile = (key) => path.join(runDir(), `${key}.cap.json`);

export function learnedCap(key) {
  try {
    const mb = count(JSON.parse(fs.readFileSync(capFile(key), "utf8")).mb);
    return mb ? Math.min(mb, CAP_CEILING_MB) : null;
  } catch {
    return null;
  }
}

export function learnCap(key, mb, why) {
  try {
    fs.writeFileSync(capFile(key), JSON.stringify({ mb, why, at: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}
