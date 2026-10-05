import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  activate, activeFor, allowOutput, createAsk, deactivate, parsePickArgs, pendingAsks, readAnswer, resolvePicks, writeAnswer,
} from "../src/standin.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(here, "..", "bin", "ask-guard.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "answer-for-me-standin-"));
const QUESTIONS = [
  { question: "Which color?", header: "Color", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] },
  { question: "Which sizes?", header: "Size", multiSelect: true, options: [{ label: "S" }, { label: "M" }, { label: "L" }] },
];

test("activeFor: covers sessions inside the project, never the stand-in itself or a dead one", () => {
  const home = tmp();
  const project = path.join(home, "work", "app");
  activate({ home, project, name: "me", sessionId: "s-me", pid: process.pid });
  assert.equal(activeFor({ home, cwd: path.join(project, "web"), sessionId: "s-other" })?.name, "me");
  assert.equal(activeFor({ home, cwd: project, sessionId: "s-me" }), null);
  assert.equal(activeFor({ home, cwd: path.join(home, "work", "shop"), sessionId: "s-other" }), null);
  assert.equal(activeFor({ home, cwd: project, sessionId: "s-other", alive: () => false }), null);
  assert.equal(deactivate({ home, project }), true);
  assert.equal(activeFor({ home, cwd: project, sessionId: "s-other" }), null);
  assert.equal(deactivate({ home, project }), false);
});

test("activeFor: the most specific project wins when stand-ins are nested", () => {
  const home = tmp();
  const outer = path.join(home, "work");
  const inner = path.join(outer, "app");
  activate({ home, project: outer, name: "outer", sessionId: "a", pid: process.pid });
  activate({ home, project: inner, name: "inner", sessionId: "b", pid: process.pid });
  assert.equal(activeFor({ home, cwd: path.join(inner, "x"), sessionId: "c" }).name, "inner");
  assert.equal(activeFor({ home, cwd: path.join(outer, "y"), sessionId: "c" }).name, "outer");
});

test("resolvePicks: option numbers become labels, text passes through, mistakes throw", () => {
  assert.deepEqual(resolvePicks(QUESTIONS, { 1: [2], 2: [1, 3] }), { "Which color?": "Blue", "Which sizes?": "S, L" });
  assert.deepEqual(resolvePicks(QUESTIONS, { 1: "Green, as in the logo", 2: [2] }), { "Which color?": "Green, as in the logo", "Which sizes?": "M" });
  assert.throws(() => resolvePicks(QUESTIONS, { 1: [1] }), /no answer for question 2/);
  assert.throws(() => resolvePicks(QUESTIONS, { 1: [1, 2], 2: [1] }), /takes one option/);
  assert.throws(() => resolvePicks(QUESTIONS, { 1: [3], 2: [1] }), /has no option 3/);
});

test("parsePickArgs: 1=2 2=1,3 3=:text", () => {
  assert.deepEqual(parsePickArgs(["1=2", "2=1,3", "3=:any = text"]), { 1: [2], 2: [1, 3], 3: "any = text" });
  assert.throws(() => parsePickArgs(["two"]), /bad pick/);
});

test("pendingAsks: only unanswered asks for this stand-in; day-old leftovers are removed", () => {
  const home = tmp();
  const standIn = { name: "me", sessionId: "s-me", project: "/p" };
  const now = Date.now();
  const a = createAsk({ home, standIn, sessionId: "x", cwd: "/p", questions: QUESTIONS, now });
  const b = createAsk({ home, standIn, sessionId: "y", cwd: "/p", questions: QUESTIONS, now: now + 1 });
  createAsk({ home, standIn: { ...standIn, sessionId: "other" }, sessionId: "z", cwd: "/p", questions: QUESTIONS, now });
  const old = createAsk({ home, standIn, sessionId: "w", cwd: "/p", questions: QUESTIONS, now: now - 2 * 24 * 3600e3 });
  writeAnswer(b, { answers: {} }, home);
  assert.deepEqual(pendingAsks({ home, standInSessionId: "s-me", now }).map((x) => x.id), [a]);
  assert.equal(fs.existsSync(path.join(home, "answer-for-me", "asks", `${old}.json`)), false);
  assert.deepEqual(readAnswer(b, home), { answers: {} });
});

test("allowOutput: allow + answers + a note saying who answered", () => {
  const out = allowOutput(QUESTIONS, { "Which color?": "Blue", "Which sizes?": "M" }, "stand-in-1");
  const h = out.hookSpecificOutput;
  assert.equal(h.hookEventName, "PreToolUse");
  assert.equal(h.permissionDecision, "allow");
  assert.deepEqual(h.updatedInput.answers, { "Which color?": "Blue", "Which sizes?": "M" });
  assert.deepEqual(h.updatedInput.questions, QUESTIONS);
  assert.match(h.additionalContext, /stand-in-1/);
  assert.match(h.updatedInput.annotations["Which color?"].notes, /not typed by the user/);
});

function runGuard(home, input, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [GUARD], { env: { ...process.env, CLAUDE_CONFIG_DIR: home, ...env } });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("exit", (code) => resolve({ code, out }));
    p.stdin.end(JSON.stringify(input));
  });
}

test("ask-guard: no stand-in on -> silent, the dialog opens as usual", async () => {
  const home = tmp();
  const r = await runGuard(home, { tool_name: "AskUserQuestion", session_id: "x", cwd: home, tool_input: { questions: QUESTIONS } });
  assert.deepEqual(r, { code: 0, out: "" });
});

test("ask-guard: hands the questions to the stand-in and returns its answer", async () => {
  const home = tmp();
  const project = path.join(home, "app");
  activate({ home, project, name: "me", sessionId: "s-me", pid: process.pid });
  const running = runGuard(home, { tool_name: "AskUserQuestion", session_id: "asker", cwd: project, tool_input: { questions: QUESTIONS } });
  let ask;
  for (let i = 0; i < 50 && !ask; i++) {
    await new Promise((r) => setTimeout(r, 100));
    ask = pendingAsks({ home, standInSessionId: "s-me" })[0];
  }
  assert.ok(ask, "the hook wrote an ask");
  assert.equal(ask.sessionId, "asker");
  writeAnswer(ask.id, { answers: resolvePicks(ask.questions, { 1: [1], 2: [2, 3] }) }, home);
  const r = await running;
  assert.equal(r.code, 0);
  const h = JSON.parse(r.out).hookSpecificOutput;
  assert.equal(h.permissionDecision, "allow");
  assert.deepEqual(h.updatedInput.answers, { "Which color?": "Red", "Which sizes?": "M, L" });
  assert.deepEqual(pendingAsks({ home }), []);
});

test("ask-guard: pass and timeout both fall back to the dialog", async () => {
  const home = tmp();
  const project = path.join(home, "app");
  activate({ home, project, name: "me", sessionId: "s-me", pid: process.pid });
  const input = { tool_name: "AskUserQuestion", session_id: "asker", cwd: project, tool_input: { questions: QUESTIONS } };

  const passing = runGuard(home, input);
  let ask;
  for (let i = 0; i < 50 && !ask; i++) {
    await new Promise((r) => setTimeout(r, 100));
    ask = pendingAsks({ home })[0];
  }
  writeAnswer(ask.id, { pass: true }, home);
  assert.deepEqual(await passing, { code: 0, out: "" });

  const r = await runGuard(home, input, { ANSWER_FOR_ME_WAIT_SECONDS: "1" });
  assert.deepEqual(r, { code: 0, out: "" });
  assert.deepEqual(pendingAsks({ home }), []);
});

test("ask-guard: other tools and bad input never fail the session", async () => {
  const home = tmp();
  assert.deepEqual(await runGuard(home, { tool_name: "Bash" }), { code: 0, out: "" });
  const p = spawn(process.execPath, [GUARD], { env: { ...process.env, CLAUDE_CONFIG_DIR: home } });
  const code = await new Promise((resolve) => { p.on("exit", resolve); p.stdin.end("not json"); });
  assert.equal(code, 0);
});
