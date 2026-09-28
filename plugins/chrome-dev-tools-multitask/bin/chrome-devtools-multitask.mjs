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
//   CDP_MCP_VERSION   chrome-devtools-mcp version to run (default chrome-devtools-mcp@1.9.0)
//   CDP_MAX_SLOTS     persistent profiles (default 8); beyond that a throwaway one
//   CDP_IDLE_MINUTES  close an unused browser after this long (default 30; 0 = never)
//   CDP_LAZY=0        start the server with the session, like the official plugin
//   CDP_EXTRA_ARGS    more chrome-devtools-mcp flags, e.g. "--headless --slim"
//   CDP_HOME          where profiles and slots live (default ~/.cache/chrome-devtools-mcp)
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCache } from "../src/cache.mjs";
import { frame, lineReader } from "../src/lines.mjs";
import { Proxy } from "../src/proxy.mjs";
import { killBrowsersOn, startServer } from "../src/server.mjs";
import { createSlots } from "../src/slots.mjs";

const env = process.env;
const nonNegative = (v, fallback) => (/^\d+(\.\d+)?$/.test(String(v ?? "")) ? Number(v) : fallback);

const HOME = env.CDP_HOME || path.join(os.homedir(), ".cache", "chrome-devtools-mcp");
const SPEC = env.CDP_MCP_VERSION || "chrome-devtools-mcp@1.9.0";
const MAX_SLOTS = Math.max(1, Math.floor(nonNegative(env.CDP_MAX_SLOTS, 8)));
const IDLE_MS = nonNegative(env.CDP_IDLE_MINUTES, 30) * 60 * 1000;
const LAZY = env.CDP_LAZY !== "0";
const EXTRA = [...(env.CDP_EXTRA_ARGS ?? "").split(/\s+/).filter(Boolean), ...process.argv.slice(2)];
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
const proxy = new Proxy({
  toClient: (msg) => process.stdout.write(frame(msg)),
  startServer: ({ args, onMessage, onExit }) => {
    const server = startServer({ spec: SPEC, args, onMessageChunk: lineReader(onMessage), onExit, log });
    return { write: (msg) => server.write(frame(msg)), stop: () => server.stop() };
  },
  slots: createSlots({ home: HOME, maxSlots: MAX_SLOTS, project: projectOf(process.cwd()), log }),
  cache: createCache(path.join(HOME, "multitask", `cache-${scope}.json`), log),
  killBrowsers: (profile) => killBrowsersOn(profile, log),
  log,
  idleMs: IDLE_MS,
  lazy: LAZY,
  extraArgs: SERVER_ARGS,
  cacheScope: scope,
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
