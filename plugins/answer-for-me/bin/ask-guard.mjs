#!/usr/bin/env node
// ask-guard.mjs — PreToolUse hook on AskUserQuestion, in every session.
//
// No live stand-in for this session's project: exits at once, the dialog opens
// as usual. Otherwise it hands the questions to the stand-in and waits for its
// answer (ANSWER_FOR_ME_WAIT_SECONDS, default 600). An answer resolves the tool
// with no dialog; "pass", a timeout or any error falls back to the dialog.
// It never blocks a session by failing: every path ends in exit 0.
import fs from "node:fs";
import path from "node:path";
import { claudeHome, readSessions } from "../src/sessions.mjs";
import { activeFor, allowOutput, closeAsk, createAsk, readAnswer } from "../src/standin.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  if (input.tool_name !== "AskUserQuestion") return;
  const questions = input.tool_input?.questions;
  if (!Array.isArray(questions) || !questions.length) return;
  if (input.tool_input?.answers && Object.keys(input.tool_input.answers).length) return;

  const home = claudeHome();
  const cwd = input.cwd || process.cwd();
  const standIn = activeFor({ home, cwd, sessionId: input.session_id });
  if (!standIn) return;

  const me = readSessions(home).find((s) => s.sessionId === input.session_id);
  const id = createAsk({ home, standIn, sessionId: input.session_id, sessionName: me?.name, cwd, questions });
  const waitMs = (Number(process.env.ANSWER_FOR_ME_WAIT_SECONDS) || 600) * 1000;
  const deadline = Date.now() + waitMs;
  try {
    while (Date.now() < deadline) {
      const answer = readAnswer(id, home);
      if (answer) {
        if (answer.pass || !answer.answers) return;
        process.stdout.write(JSON.stringify(allowOutput(questions, answer.answers, standIn.name)));
        return;
      }
      if (!fs.existsSync(path.join(home, "answer-for-me", "asks", `${id}.json`))) return;
      await sleep(1000);
    }
  } finally {
    closeAsk(id, home);
  }
}

main().catch(() => {}).finally(() => process.exit(0));
