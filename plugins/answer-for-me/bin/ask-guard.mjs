#!/usr/bin/env node
// ask-guard.mjs — PermissionRequest hook on AskUserQuestion, in every session.
//
// Claude Code runs PermissionRequest hooks alongside the open dialog, in the
// terminal UI and for a stream-json host like the desktop app (2.1.296): a hook
// that answers first closes the dialog. So this hook offers every dialog to the
// project's stand-in, including one that goes on duty after the dialog opened:
// it writes the ask, then waits until
//   - the stand-in answers: print allow + updatedInput.answers (the dialog closes);
//   - the stand-in passes, or the ask is withdrawn: exit, the dialog stays the user's;
//   - the user answers in the dialog (its tool_result reaches the transcript),
//     the session exits, or ANSWER_FOR_ME_WAIT_SECONDS (default 86000) run out.
//
// In a subagent Claude Code waits for this hook *before* it shows the dialog.
// There it waits only when a stand-in is already on, and only 10 minutes.
// It never blocks a session by failing: every path ends in exit 0, and no
// output means the user's dialog decides.
import fs from "node:fs";
import { DialogWatch } from "../src/dialog.mjs";
import { claudeHome, pidAlive, readSessions } from "../src/sessions.mjs";
import { activeFor, allowOutput, askExists, closeAsk, createAsk, readAnswer } from "../src/standin.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = Number(process.env.ANSWER_FOR_ME_POLL_MS) || 1000;

async function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  if (input.tool_name !== "AskUserQuestion") return;
  const questions = input.tool_input?.questions;
  if (!Array.isArray(questions) || !questions.length) return;
  if (input.tool_input?.answers && Object.keys(input.tool_input.answers).length) return;

  const home = claudeHome();
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id;
  const subagent = Boolean(input.agent_id);
  const me = readSessions(home).find((s) => s.sessionId === sessionId);
  // A session working in a folder added to it asks from that folder; its root
  // (the session file's cwd) is still its project, so a stand-in there covers it.
  const dirs = [...new Set([cwd, me?.cwd].filter(Boolean))];
  if (subagent && !activeFor({ home, cwd: dirs, sessionId })) return;

  const waitS = Number(process.env.ANSWER_FOR_ME_WAIT_SECONDS) || (subagent ? 600 : 86000);
  const deadline = Date.now() + waitS * 1000;
  const id = createAsk({
    home, sessionId, sessionName: me?.name, sessionPid: me?.pid, agentId: input.agent_id, cwd, dirs, questions,
  });
  // A subagent's tool calls are in its own transcript, not in transcript_path.
  const dialog = subagent ? null : new DialogWatch(input.transcript_path, questions);
  let outcome = "timeout";
  try {
    for (;;) {
      if (dialog?.answered()) { outcome = "answered-in-dialog"; return; }
      const answer = readAnswer(id, home);
      if (answer) {
        if (answer.pass || !answer.answers) { outcome = "passed"; return; }
        const by = answer.by || activeFor({ home, cwd: dirs, sessionId })?.name;
        process.stdout.write(JSON.stringify(allowOutput(questions, answer.answers, by)));
        outcome = "delivered";
        return;
      }
      if (!askExists(id, home)) { outcome = "withdrawn"; return; }
      if (me?.pid && !pidAlive(me.pid)) { outcome = "session-gone"; return; }
      if (Date.now() >= deadline) return;
      await sleep(POLL_MS);
    }
  } finally {
    closeAsk(id, home, outcome);
  }
}

main().catch(() => {}).finally(() => process.exit(0));
