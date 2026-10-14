#!/usr/bin/env node
// e2e.mjs — the dialog hook against a real Claude Code, the way the desktop app
// runs it (stream-json in and out, --permission-prompt-tool=stdio). This script
// is the host: it gets the can_use_tool request (the dialog) and either never
// answers it or answers it as the user. Not part of `npm test`: it calls the
// API (haiku, one short turn per case) and needs a live session to act as the
// stand-in. Re-run it after a Claude Code update.
//
//   STANDIN_NAME=<a live session's name> node scripts/e2e.mjs
//
// Cases:
//   late-standin  the dialog opens with no stand-in on; 6 s later a stand-in
//                 comes on, `watch` must list it, `answer` must print
//                 "delivered", and the host must get control_cancel_request.
//   user-first    the host answers the dialog; the hook must notice and exit
//                 (outcome answered-in-dialog) while claude is still running.
// Env: CLAUDE_BIN (default ~/.local/bin/claude[.exe]), E2E_MODEL (default haiku).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STANDIN = path.join(PLUGIN, "bin", "standin.mjs");
const ME = process.env.STANDIN_NAME;
if (!ME) { console.error("set STANDIN_NAME to a live session's name (ListAgents: \"This session is <name>\")"); process.exit(2); }
const CLAUDE = process.env.CLAUDE_BIN || path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const asks = path.join(home, "answer-for-me", "asks");
const PROMPT = "Test of a tool. Call the AskUserQuestion tool exactly once with one question: question \"Which color?\", header \"Color\", multiSelect false, options: \"Red\" (description \"warm\") and \"Blue\" (description \"cool\"). After you get the answer, reply with one line: ANSWER=<the answer you got> NOTES=<any notes shown with it>. Do nothing else.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runCase(name, onDialog) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `answer-for-me-e2e-${name}-`));
  const t0 = Date.now();
  const log = (...a) => console.log(`[${name} +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
  const standin = (...a) => {
    const r = spawnSync(process.execPath, [STANDIN, ...a], { cwd: work, encoding: "utf8" });
    return `${r.stdout}${r.stderr}`.trim();
  };
  const seen = { cancel: false, result: "", toolResult: "" };
  const cp = spawn(CLAUDE, [
    "--output-format", "stream-json", "--verbose", "--input-format", "stream-json",
    "--model", process.env.E2E_MODEL || "haiku", "--permission-prompt-tool=stdio", "--setting-sources=project,local",
    "--permission-mode=bypassPermissions", "--allow-dangerously-skip-permissions", "--plugin-dir", PLUGIN,
  ], { cwd: work, stdio: ["pipe", "pipe", "inherit"] });
  const send = (o) => cp.stdin.write(`${JSON.stringify(o)}\n`);
  const ctx = { log, standin, send, work, seen };
  return new Promise((resolve) => {
    let finished = false;
    readline.createInterface({ input: cp.stdout }).on("line", (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.type === "control_request" && m.request?.subtype === "can_use_tool" && m.request.tool_name === "AskUserQuestion") {
        log("dialog open (can_use_tool)");
        ctx.dialog = { requestId: m.request_id, questions: m.request.input.questions };
        ctx.check = onDialog(ctx);
      } else if (m.type === "control_cancel_request") {
        seen.cancel = true;
        log("control_cancel_request: the dialog closed");
      } else if (m.type === "user" && Array.isArray(m.message?.content)) {
        const r = m.message.content.find((c) => c.type === "tool_result");
        if (r) { seen.toolResult = String(r.content); log("tool_result:", seen.toolResult.slice(0, 220)); }
      } else if (m.type === "result" && !finished) {
        finished = true;
        seen.result = String(m.result ?? "");
        log("result:", seen.result);
        // Keep claude alive a while: the hook must leave on its own, not because claude exited.
        Promise.resolve(ctx.check).then(async (ok) => {
          cp.stdin.end();
          await sleep(3000);
          cp.kill();
          try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* claude may still hold it */ }
          resolve(ok);
        });
      }
    });
    cp.on("exit", () => { if (!finished) { log("claude exited before a result"); resolve(false); } });
    send({ type: "control_request", request_id: "init-1", request: { subtype: "initialize" } });
    send({ type: "user", message: { role: "user", content: PROMPT } });
    setTimeout(() => { if (!finished) { log("timed out"); cp.kill(); resolve(false); } }, 150000);
  });
}

async function lateStandIn({ log, standin, work, seen }) {
  try {
    await sleep(6000);
    log("standin on:", standin("on", "--name", ME, "--project", work).replace(/\n/g, " / "));
    const w = spawn(process.execPath, [STANDIN, "watch", "--name", ME], { cwd: work });
    let out = "";
    w.stdout.on("data", (d) => { out += d; });
    await sleep(2500);
    w.kill();
    log("watch:", out.trim());
    const id = /^ASK (\S+)/m.exec(out)?.[1];
    if (!id) return false;
    const answer = standin("answer", id, "1=2");
    log("answer:", answer.replace(/\n/g, " / "));
    for (let i = 0; i < 20 && !seen.toolResult; i++) await sleep(250);
    return /delivered/.test(answer) && seen.cancel && /Blue/.test(seen.toolResult) && /Answered by/.test(seen.toolResult);
  } finally {
    standin("off", "--project", work);
  }
}

async function userFirst({ log, send, dialog }) {
  await sleep(3000);
  const open = fs.readdirSync(asks).filter((n) => /^[a-z0-9]+-[0-9a-f]{6}\.json$/.test(n))
    .map((n) => JSON.parse(fs.readFileSync(path.join(asks, n), "utf8")))
    .filter((a) => a.questions?.[0]?.question === "Which color?");
  const id = open.at(-1)?.id;
  log("ask written by the hook:", id ?? "none");
  send({
    type: "control_response",
    response: { subtype: "success", request_id: dialog.requestId, response: { behavior: "allow", updatedInput: { questions: dialog.questions, answers: { "Which color?": "Red" } } } },
  });
  log("answered as the user");
  for (let i = 0; i < 20 && id; i++) {
    await sleep(250);
    const f = path.join(asks, `${id}.done.json`);
    if (fs.existsSync(f)) {
      const { outcome } = JSON.parse(fs.readFileSync(f, "utf8"));
      log("hook left:", outcome);
      return outcome === "answered-in-dialog";
    }
  }
  log("the hook was still waiting 5 s after the user answered");
  return false;
}

const results = { "late-standin": await runCase("late-standin", lateStandIn), "user-first": await runCase("user-first", userFirst) };
for (const [k, ok] of Object.entries(results)) console.log(`${ok ? "PASS" : "FAIL"} ${k}`);
process.exit(Object.values(results).every(Boolean) ? 0 : 1);
