import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAnswers, createCache } from "../src/cache.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cdp-cache-"));

test("two sessions writing the cache keep each other's entries", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "multitask", "cache.json");
    const a = createCache(file);
    const b = createCache(file);
    assert.equal(b.get("init", "x"), null); // b loaded the (empty) file before a wrote
    a.set("init", "s|2025-06-18", { v: 1 });
    b.set("init", "s|2025-11-25", { v: 2 });
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(onDisk.init, { "s|2025-06-18": { v: 1 }, "s|2025-11-25": { v: 2 } });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["cache.json"], "no temp file left behind");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a corrupt cache file reads as empty", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "cache.json");
    fs.writeFileSync(file, "{not json");
    assert.equal(createCache(file).get("tools", "k"), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function answers({ learned = {}, bundled = null } = {}) {
  const store = structuredClone(learned);
  return createAnswers({
    scope: "s",
    bundled,
    learned: {
      get: (kind, key) => store[kind]?.[key] ?? null,
      entries: (kind) => Object.entries(store[kind] ?? {}),
      set: (kind, key, value) => { store[kind] = { ...(store[kind] ?? {}), [key]: value }; },
    },
  });
}

test("what this machine learned wins over the bundled snapshot", () => {
  const a = answers({ learned: { init: { "s|2025-06-18": "learned" } }, bundled: { init: { "2025-06-18": "bundled" } } });
  assert.equal(a.get("init", "s|2025-06-18"), "learned");
});

test("the bundled snapshot answers a machine's first session", () => {
  const a = answers({ bundled: { init: { "2025-06-18": "old", "2025-11-25": "new" } } });
  assert.equal(a.get("init", "s|2025-06-18"), "old");
  assert.equal(a.get("init", "s|2025-11-25"), "new");
});

test("a protocol newer than any known answer gets the newest one; an older one asks the server", () => {
  const a = answers({ bundled: { init: { "2025-06-18": "old", "2025-11-25": "new" } } });
  assert.equal(a.get("init", "s|2026-06-30"), "new", "the server would answer with its latest too");
  assert.equal(a.get("init", "s|2024-11-05"), null, "the server might support it, so it is asked");
});

test("answers learned under another scope (other version or flags) are not used", () => {
  const a = answers({ learned: { tools: { "other|2025-06-18": "theirs" } } });
  assert.equal(a.get("tools", "s|2025-06-18"), null);
  assert.equal(a.get("tools", "s|2026-01-01"), null);
});

test("set writes through to what this machine learned", () => {
  const a = answers();
  a.set("tools", "s|2025-06-18", "list");
  assert.equal(a.get("tools", "s|2025-06-18"), "list");
});
