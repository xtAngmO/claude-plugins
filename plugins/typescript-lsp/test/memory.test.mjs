import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tsd-memory-"));
process.env.TSD_RUN_DIR = RUN_DIR;
const {
  CAP_CEILING_MB, DEFAULT_TSSERVER_MEMORY_MB, effectiveCap, learnCap, learnedCap, nextCap, pressureThresholdMB, underPressure,
} = await import("../src/memory.mjs");
after(() => fs.rmSync(RUN_DIR, { recursive: true, force: true }));

const MB = 1024 * 1024;
const GB64 = () => 64 * 1024 * MB;
const GB8 = () => 8 * 1024 * MB;

test("memory is low below an eighth of RAM, but never below 8 GB of headroom on a big machine", () => {
  assert.equal(pressureThresholdMB({ env: {}, platform: "win32", totalmem: GB64 }), 8192);
  assert.equal(pressureThresholdMB({ env: {}, platform: "linux", totalmem: GB8 }), 1024);
});

test("macOS reads free memory without its cache, so pressure there is opt-in", () => {
  assert.equal(pressureThresholdMB({ env: {}, platform: "darwin", totalmem: GB64 }), 0);
  assert.equal(pressureThresholdMB({ env: { TSD_PRESSURE_FREE_MB: "2048" }, platform: "darwin", totalmem: GB64 }), 2048);
});

test("TSD_PRESSURE_FREE_MB sets the threshold, and 0 turns pressure off", () => {
  const free = () => 1 * MB;
  assert.equal(underPressure({ env: { TSD_PRESSURE_FREE_MB: "0" }, platform: "win32", totalmem: GB64, freemem: free }), false);
  assert.equal(underPressure({ env: { TSD_PRESSURE_FREE_MB: "512" }, platform: "win32", totalmem: GB64, freemem: free }), true);
  assert.equal(underPressure({ env: { TSD_PRESSURE_FREE_MB: "nonsense" }, platform: "win32", totalmem: GB64, freemem: free }), true, "falls back to the default");
});

test("under pressure only while available memory is below the threshold", () => {
  const at = (mb) => underPressure({ env: {}, platform: "win32", totalmem: GB64, freemem: () => mb * MB });
  assert.equal(at(8191), true);
  assert.equal(at(8192), false);
  assert.equal(at(30000), false);
});

test("the default cap sits between what the biggest measured project needs and the old 12 GB", () => {
  assert.ok(DEFAULT_TSSERVER_MEMORY_MB >= 4300 * 1.5, "1.5 × the largest live heap measured");
  assert.ok(DEFAULT_TSSERVER_MEMORY_MB < CAP_CEILING_MB);
});

test("a learned cap only ever raises the cap that was asked for", () => {
  assert.equal(effectiveCap(6656, null), 6656);
  assert.equal(effectiveCap(6656, 12288), 12288);
  assert.equal(effectiveCap(8192, 4096), 8192, "a smaller learned cap never lowers an explicit one");
});

test("each crash doubles the cap, up to the ceiling", () => {
  assert.equal(nextCap(3072), 6144);
  assert.equal(nextCap(6656), CAP_CEILING_MB);
  assert.equal(nextCap(CAP_CEILING_MB), CAP_CEILING_MB);
});

test("a learned cap survives on disk per project key, clamped to the ceiling", () => {
  assert.equal(learnedCap("k-none"), null);
  assert.equal(learnCap("k-one", 9000, "test"), true);
  assert.equal(learnedCap("k-one"), 9000);
  learnCap("k-two", 50000, "test");
  assert.equal(learnedCap("k-two"), CAP_CEILING_MB);
  fs.writeFileSync(path.join(RUN_DIR, "k-bad.cap.json"), "{not json");
  assert.equal(learnedCap("k-bad"), null);
});
