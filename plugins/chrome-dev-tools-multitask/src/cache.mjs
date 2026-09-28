// cache.mjs — what the real server said at initialize and tools/list, on disk,
// so sessions that never touch a browser never need to start one to find out.
import fs from "node:fs";
import path from "node:path";

export function createCache(file, log = () => {}) {
  let data = null;
  const load = () => {
    if (data) return data;
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { data = {}; }
    return data;
  };
  return {
    get(kind, key) {
      return load()[kind]?.[key] ?? null;
    },
    set(kind, key, value) {
      const d = load();
      d[kind] = { ...(d[kind] ?? {}), [key]: value };
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
