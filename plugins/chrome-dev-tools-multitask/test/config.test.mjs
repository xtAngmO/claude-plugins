import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { DEBUG_PORT_ARGS, debugPortArgs, readConfig } from "../src/config.mjs";

const SPEC = "chrome-devtools-mcp@1.10.1";
const config = (env = {}, argv = []) => readConfig(env, argv, path.resolve("/home/me"));
const ports = (args) => args.filter((a) => a.includes("--remote-debugging-port"));

test("every server gets a local debug port, with the pipe kept for chrome-devtools-mcp itself", () => {
  const c = config();
  assert.deepEqual(c.serverArgs, ["--no-usage-statistics", `--logFile=${path.join(c.home, "mcp.log")}`, ...DEBUG_PORT_ARGS]);
  assert.deepEqual(DEBUG_PORT_ARGS, ["--chromeArg=--remote-debugging-pipe", "--chromeArg=--remote-debugging-port=0"],
    "puppeteer adds its own pipe only when no --remote-debugging-* flag is given, so the pipe is asked for too");
  assert.equal(c.debugPort, true);
});

test("the debug port does not change the cache scope, so the bundled snapshot still answers", () => {
  const on = config();
  const off = config({ CDP_DEBUG_PORT: "0" });
  // The scope 1.3.0 computed for the default flags: answers learned on this
  // machine before the debug port existed keep being found.
  const before = createHash("sha1").update(`${SPEC}\0`).digest("hex").slice(0, 12);
  assert.equal(on.scope, before);
  assert.equal(off.scope, before);
  assert.deepEqual(on.extra, [], "no extra flags: the bundled snapshot is used, nothing is learned at tools/list time");
  const slim = config({ CDP_EXTRA_ARGS: "--slim" });
  assert.equal(slim.scope, config({ CDP_EXTRA_ARGS: "--slim", CDP_DEBUG_PORT: "0" }).scope);
  assert.notEqual(slim.scope, before, "the user's own flags still split the scope");
});

test("CDP_DEBUG_PORT=0 (or false) leaves the port out", () => {
  for (const v of ["0", "false", "FALSE"]) {
    const c = config({ CDP_DEBUG_PORT: v });
    assert.equal(c.debugPort, false);
    assert.deepEqual(ports(c.serverArgs), []);
    assert.equal(c.serverArgs.some((a) => a.includes("--remote-debugging-pipe")), false);
  }
  assert.equal(config({ CDP_DEBUG_PORT: "1" }).debugPort, true);
});

test("a port the user already asked for is not added a second time", () => {
  for (const spelled of ["--chromeArg=--remote-debugging-port=9222", "--chrome-arg=--remote-debugging-port=9222", "--chromeArg --remote-debugging-port=9222"]) {
    const c = config({ CDP_EXTRA_ARGS: spelled });
    assert.equal(ports(c.serverArgs).length, 1, spelled);
    assert.equal(c.serverArgs.includes("--chromeArg=--remote-debugging-pipe"), false, "their setup is left exactly as they wrote it");
  }
  const viaArgv = config({}, ["--chromeArg=--remote-debugging-port=9333"]);
  assert.deepEqual(ports(viaArgv.serverArgs), ["--chromeArg=--remote-debugging-port=9333"]);
});

test("a pipe the user already asked for is not doubled either", () => {
  assert.deepEqual(debugPortArgs(["--chromeArg=--remote-debugging-pipe"]), ["--chromeArg=--remote-debugging-port=0"]);
  assert.deepEqual(debugPortArgs([], false), []);
});

test("headless flags still only set the starting mode, and stay out of the scope", () => {
  const c = config({ CDP_EXTRA_ARGS: "--headless" });
  assert.equal(c.headless, true);
  assert.deepEqual(c.extra, []);
  assert.equal(c.scope, config().scope);
  assert.equal(config({ CDP_HEADLESS: "1" }).headless, true);
  assert.equal(config().headless, false);
});

test("the other settings keep their defaults", () => {
  const c = config();
  assert.equal(c.home, path.join(path.resolve("/home/me"), ".cache", "chrome-devtools-mcp"));
  assert.equal(c.spec, SPEC);
  assert.equal(c.maxSlots, 8);
  assert.equal(c.idleMs, 30 * 60 * 1000);
  assert.equal(c.tickMs, 30 * 1000);
  assert.equal(c.lazy, true);
  const set = config({ CDP_HOME: "/x", CDP_MAX_SLOTS: "3", CDP_IDLE_MINUTES: "0", CDP_LAZY: "0", CDP_TICK_MS: "300" });
  assert.deepEqual([set.home, set.maxSlots, set.idleMs, set.lazy, set.tickMs], ["/x", 3, 0, false, 300]);
});
