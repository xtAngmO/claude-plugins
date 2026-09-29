// config.mjs — the plugin's settings, read from the environment it runs in.
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { splitHeadless } from "./proxy.mjs";

const nonNegative = (v, fallback) => (/^\d+(\.\d+)?$/.test(String(v ?? "")) ? Number(v) : fallback);

// A local debug port on every browser, so another program on this machine (a
// live view of what the session does) can attach to it. Chrome picks a free
// port on 127.0.0.1 and writes it to <user-data-dir>/DevToolsActivePort.
// Puppeteer adds its own --remote-debugging-pipe only when no
// --remote-debugging-* flag is given, so the pipe is asked for too: the server
// keeps talking to Chrome over the pipe exactly as before, and the port is an
// extra door.
export const DEBUG_PORT_ARGS = ["--chromeArg=--remote-debugging-pipe", "--chromeArg=--remote-debugging-port=0"];

// A port the user chose already opens that door; a second one would fight it.
export function debugPortArgs(extra, enabled = true) {
  if (!enabled || extra.some((a) => a.includes("--remote-debugging-port"))) return [];
  const hasPipe = extra.some((a) => a.includes("--remote-debugging-pipe"));
  return DEBUG_PORT_ARGS.filter((a) => !(hasPipe && a.endsWith("--remote-debugging-pipe")));
}

// The answer cache is keyed by the chrome-devtools-mcp version and the flags
// that can change its tools. The plugin's own flags (log file, no usage
// statistics, debug port) are left out: they change no tool, and counting them
// would skip the bundled snapshot and make every machine learn the tools again.
export const cacheScopeOf = (spec, extra) => createHash("sha1").update(`${spec}\0${extra.join(" ")}`).digest("hex").slice(0, 12);

export function readConfig(env = process.env, argv = process.argv.slice(2), homedir = os.homedir()) {
  const home = env.CDP_HOME || path.join(homedir, ".cache", "chrome-devtools-mcp");
  const spec = env.CDP_MCP_VERSION || "chrome-devtools-mcp@1.10.1";
  // A headless flag among these only sets the starting mode (see splitHeadless),
  // and it must not split the cache scope or skip the bundled answers.
  const { headless, rest: extra } = splitHeadless(
    [...(env.CDP_EXTRA_ARGS ?? "").split(/\s+/).filter(Boolean), ...argv],
    /^(1|true)$/i.test(env.CDP_HEADLESS ?? ""),
  );
  const debugPort = !/^(0|false)$/i.test(env.CDP_DEBUG_PORT ?? "");
  return {
    home,
    spec,
    maxSlots: Math.max(1, Math.floor(nonNegative(env.CDP_MAX_SLOTS, 8))),
    idleMs: nonNegative(env.CDP_IDLE_MINUTES, 30) * 60 * 1000,
    tickMs: nonNegative(env.CDP_TICK_MS, 30 * 1000),
    lazy: env.CDP_LAZY !== "0",
    headless,
    debugPort,
    // The user's flags: these split the cache scope, and any at all skip the
    // bundled snapshot, since they can change the tools.
    extra,
    // Everything each server is started with, after the proxy's profile and
    // mode flags. No usage statistics: no telemetry watchdog next to every server.
    serverArgs: ["--no-usage-statistics", `--logFile=${path.join(home, "mcp.log")}`, ...debugPortArgs(extra, debugPort), ...extra],
    scope: cacheScopeOf(spec, extra),
  };
}
