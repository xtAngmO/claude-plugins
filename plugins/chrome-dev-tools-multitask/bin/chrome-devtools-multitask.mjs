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
//   CDP_DEBUG_PORT=0  no local debug port on the browsers (default: one on
//                     127.0.0.1, named in <profile>/DevToolsActivePort)
//
// While a browser server runs, <CDP_HOME>/live/<pid>.json names the Claude Code
// session that owns it and the profile its Chrome runs on (see src/live.mjs).
import fs from "node:fs";
import path from "node:path";
import { createAnswers, createCache } from "../src/cache.mjs";
import { readConfig } from "../src/config.mjs";
import { frame, lineReader } from "../src/lines.mjs";
import { createLive } from "../src/live.mjs";
import { Proxy } from "../src/proxy.mjs";
import { killBrowsersOn, startServer } from "../src/server.mjs";
import { createSlots } from "../src/slots.mjs";

// EXTRA is the user's flags. SERVER_ARGS adds the plugin's own (log file, no
// usage statistics, debug port), which stay out of the cache scope.
const {
  home: HOME,
  spec: SPEC,
  maxSlots: MAX_SLOTS,
  idleMs: IDLE_MS,
  tickMs: TICK_MS,
  lazy: LAZY,
  headless: HEADLESS,
  extra: EXTRA,
  serverArgs: SERVER_ARGS,
  scope,
} = readConfig();

const log = (msg) => process.stderr.write(`[chrome-devtools-multitask] ${msg}\n`);

// The session's project: its git repository, else the folder it started in.
function projectOf(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return process.platform === "win32" ? d.toLowerCase() : d;
    if (path.dirname(d) === d) return process.platform === "win32" ? path.resolve(dir).toLowerCase() : path.resolve(dir);
  }
}
const PROJECT = projectOf(process.cwd());

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
const live = createLive({ home: HOME, project: PROJECT, log });
const proxy = new Proxy({
  toClient: (msg) => process.stdout.write(frame(msg)),
  startServer: ({ args, onMessage, onExit }) => {
    const server = startServer({ spec: SPEC, args, onMessageChunk: lineReader(onMessage), onExit, log });
    return { write: (msg) => server.write(frame(msg)), stop: () => server.stop() };
  },
  slots: createSlots({ home: HOME, maxSlots: MAX_SLOTS, project: PROJECT, log }),
  cache,
  killBrowsers: (profile) => killBrowsersOn(profile, log),
  log,
  idleMs: IDLE_MS,
  lazy: LAZY,
  extraArgs: SERVER_ARGS,
  cacheScope: scope,
  headless: HEADLESS,
  live,
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
// However this process ends (an uncaught error, say), no live file outlives it.
process.on("exit", () => live.remove());
setInterval(() => { proxy.tick(); }, TICK_MS).unref();
