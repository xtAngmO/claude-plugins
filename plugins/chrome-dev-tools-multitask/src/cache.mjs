// cache.mjs — what the real server said at initialize and tools/list, on disk,
// so sessions that never touch a browser never need to start one to find out.
import fs from "node:fs";
import path from "node:path";

export function createCache(file, log = () => {}) {
  let data = null;
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
  };
  return {
    get(kind, key) {
      data ??= read();
      return data[kind]?.[key] ?? null;
    },
    entries(kind) {
      data ??= read();
      return Object.entries(data[kind] ?? {});
    },
    set(kind, key, value) {
      // Re-read first: other sessions write this file too, and merging into a
      // copy loaded at startup would drop what they added since.
      const d = read();
      d[kind] = { ...(d[kind] ?? {}), [key]: value };
      data = d;
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(d));
        fs.renameSync(tmp, file);
      } catch (e) {
        log(`could not save the cache: ${e.message}`);
      }
    },
  };
}

// The answers a session is given without a server: what this machine learned,
// else the snapshot shipped with the plugin. Keys are "<scope>|<protocol>".
//
// A client asking for a protocol newer than any known answer gets the newest
// known one — exactly what the server would say, since a server answers a
// version it does not know with the latest it supports. Asking for an older
// one than known gets nothing (the server might support it), so the server is
// asked instead.
export function createAnswers({ learned, bundled, scope }) {
  const known = (kind) => {
    const byVersion = new Map();
    for (const [pv, value] of Object.entries(bundled?.[kind] ?? {})) byVersion.set(pv, value);
    for (const [key, value] of learned.entries?.(kind) ?? []) {
      if (key.startsWith(`${scope}|`)) byVersion.set(key.slice(scope.length + 1), value);
    }
    return byVersion;
  };
  return {
    get(kind, key) {
      const exact = learned.get(kind, key);
      if (exact) return exact;
      const protocol = key.slice(scope.length + 1);
      const byVersion = known(kind);
      if (byVersion.has(protocol)) return byVersion.get(protocol);
      const newest = [...byVersion.keys()].sort().at(-1);
      return newest && protocol > newest ? byVersion.get(newest) : null;
    },
    set: (kind, key, value) => learned.set(kind, key, value),
  };
}
