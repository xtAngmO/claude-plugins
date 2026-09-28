#!/usr/bin/env node
// Record what a chrome-devtools-mcp version answers to initialize and
// tools/list, for the protocol versions Claude Code speaks, into
// data/answers-<spec>.json. The plugin ships that file so even the very first
// session on a machine is answered without starting a server — which matters
// because the first start may have to download the package, and Claude Code
// gives an MCP server 30 seconds to connect.
//
//   node scripts/snapshot.mjs [chrome-devtools-mcp@1.10.1] [protocolVersion…]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { frame, lineReader } from "../src/lines.mjs";
import { serverCommand } from "../src/server.mjs";

const [spec = "chrome-devtools-mcp@1.10.1", ...versions] = process.argv.slice(2);
const protocols = versions.length ? versions : ["2025-11-25", "2025-06-18"];
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", `answers-${spec}.json`);

async function ask(protocolVersion) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-snapshot-"));
  const cmd = serverCommand(spec, [`--user-data-dir=${profile}`, "--headless", "--no-usage-statistics"]);
  const child = spawn(cmd.command, cmd.args, { stdio: ["pipe", "pipe", "ignore"], shell: cmd.shell, windowsHide: true });
  const got = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", lineReader((m) => { if (m.id !== undefined) got.set(m.id, m); }));
  const request = async (id, method, params) => {
    child.stdin.write(frame({ jsonrpc: "2.0", id, method, params }));
    const end = Date.now() + 120000;
    while (!got.has(id)) {
      if (Date.now() > end) throw new Error(`${spec} did not answer ${method}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const m = got.get(id);
    if (m.error) throw new Error(`${method}: ${m.error.message}`);
    return m.result;
  };
  try {
    const init = await request(1, "initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "snapshot", version: "0" } });
    child.stdin.write(frame({ jsonrpc: "2.0", method: "notifications/initialized" }));
    const tools = await request(2, "tools/list", {});
    return { init, tools };
  } finally {
    child.stdin.end();
    await new Promise((r) => (child.exitCode !== null ? r() : child.on("exit", r)));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}

const answers = { spec, recordedAt: new Date().toISOString(), init: {}, tools: {} };
for (const pv of protocols) {
  const { init, tools } = await ask(pv);
  answers.init[pv] = init;
  answers.tools[pv] = tools;
  console.log(`${pv}: server speaks ${init.protocolVersion}, ${tools.tools.length} tools`);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(answers, null, 1)}\n`);
console.log(`wrote ${out}`);
