#!/usr/bin/env node
// chrome-devtools-multitask — chrome-devtools-mcp for many sessions at once.
//
// Each session that opens a browser gets its own Chrome window on its own
// persistent profile (a slot), preferring the profile its project used last.
// Sessions that never browse run no browser server at all, and a browser left
// unused is closed after a while.
//
// stdout is the MCP transport: nothing but protocol goes there. Diagnostics
// go to stderr, which the MCP client keeps in its log.
//
//   CDP_MCP_VERSION   chrome-devtools-mcp version to run (default chrome-devtools-mcp@1.10.1)
//   CDP_MAX_SLOTS     persistent profiles (default 8); beyond that a throwaway one
//   CDP_IDLE_MINUTES  close an unused browser after this long (default 30; 0 = never)
//   CDP_LAZY=0        start the server with the session, like the official plugin
//   CDP_HEADLESS=1    run browsers hidden, headless (default: a visible window; a
//                     session can switch with the set_browser_visible tool)
//   CDP_EXTRA_ARGS    more chrome-devtools-mcp flags, e.g. "--slim --channel=beta"
//                     (--headless / --no-headless here only set the starting mode)
//   CDP_HOME          where profiles and slots live (default ~/.cache/chrome-devtools-mcp)
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAnswers, createCache } from "../src/cache.mjs";
import { frame, lineReader } from "../src/lines.mjs";
import { Proxy, splitHeadless } from "../src/proxy.mjs";
import { killBrowsersOn, startServer } from "../src/server.mjs";
import { createSlots } from "../src/slots.mjs";

const env = process.env;
const nonNegative = (v, fallback) => (/^\d+(\.\d+)?$/.test(String(v ?? "")) ? Number(v) : fallback);

const HOME = env.CDP_HOME || path.join(os.homedir(), ".cache", "chrome-devtools-mcp");
const SPEC = env.CDP_MCP_VERSION || "chrome-devtools-mcp@1.10.1";
const MAX_SLOTS = Math.max(1, Math.floor(nonNegative(env.CDP_MAX_SLOTS, 8)));
const IDLE_MS = nonNegative(env.CDP_IDLE_MINUTES, 30) * 60 * 1000;
const LAZY = env.CDP_LAZY !== "0";
// A headless flag among these only sets the starting mode (see splitHeadless),
// and it must not split the cache scope or skip the bundled answers.
const { headless: HEADLESS, rest: EXTRA } = splitHeadless(
  [...(env.CDP_EXTRA_ARGS ?? "").split(/\s+/).filter(Boolean), ...process.argv.slice(2)],
  /^(1|true)$/i.test(env.CDP_HEADLESS ?? ""),
);
// No usage statistics: no telemetry watchdog process next to every server.
const SERVER_ARGS = ["--no-usage-statistics", `--logFile=${path.join(HOME, "mcp.log")}`, ...EXTRA];

const log = (msg) => process.stderr.write(`[chrome-devtools-multitask] ${msg}\n`);

// The session's project: its git repository, else the folder it started in.
function projectOf(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return process.platform === "win32" ? d.toLowerCase() : d;
    if (path.dirname(d) === d) return process.platform === "win32" ? path.resolve(dir).toLowerCase() : path.resolve(dir);
  }
}

const scope = createHash("sha1").update(`${SPEC}\0${EXTRA.join(" ")}`).digest("hex").slice(0, 12);

// What this version answers, recorded when the plugin was built
// (scripts/snapshot.mjs), so even a machine's first session starts no server:
// that first start may need a download, and Claude Code gives an MCP server
// 30 s to connect. Only for the default flags; extra ones can change the tools.
function bundledAnswers() {
  if (EXTRA.length) return null;
  try {
    const file = new URL(`../data/answers-${SPEC}.json`, import.meta.url);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
const cache = createAnswers({
  learned: createCache(path.join(HOME, "multitask", `cache-${scope}.json`), log),
  bundled: bundledAnswers(),
  scope,
});
const proxy = new Proxy({
  toClient: (msg) => process.stdout.write(frame(msg)),
  startServer: ({ args, onMessage, onExit }) => {
    const server = startServer({ spec: SPEC, args, onMessageChunk: lineReader(onMessage), onExit, log });
    return { write: (msg) => server.write(frame(msg)), stop: () => server.stop() };
  },
  slots: createSlots({ home: HOME, maxSlots: MAX_SLOTS, project: projectOf(process.cwd()), log }),
  cache,
  killBrowsers: (profile) => killBrowsersOn(profile, log),
  log,
  idleMs: IDLE_MS,
  lazy: LAZY,
  extraArgs: SERVER_ARGS,
  cacheScope: scope,
  headless: HEADLESS,
});

let ending = false;
const end = async () => {
  if (ending) return;
  ending = true;
  await proxy.close();
  process.exit(0);
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", lineReader((msg) => proxy.fromClient(msg), (line) => log(`ignored a line that is not JSON: ${line.slice(0, 80)}`)));
process.stdin.on("end", end);
process.stdin.on("error", end);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, end);
setInterval(() => { proxy.tick(); }, nonNegative(env.CDP_TICK_MS, 30 * 1000)).unref();
