import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  activate, activeFor, allowOutput, askDirs, askLive, closeAsk, createAsk, deactivate, parsePickArgs, pendingAsks, pickStandIn,
  readAnswer, readOutcome, resolvePicks, writeAnswer,
} from "../src/standin.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(here, "..", "bin", "ask-guard.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "answer-for-me-standin-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUESTIONS = [
  { question: "Which color?", header: "Color", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] },
  { question: "Which sizes?", header: "Size", multiSelect: true, options: [{ label: "S" }, { label: "M" }, { label: "L" }] },
];
const MINUTE = 60e3;
// A pid that is certainly not running: a child that has already exited.
const DEAD_PID = spawnSync(process.execPath, ["-e", ""]).pid;

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

test("pickStandIn: the most specific project wins when stand-ins are nested", () => {
  const outer = path.resolve("/work");
  const inner = path.join(outer, "app");
  const markers = [{ project: outer, name: "outer", sessionId: "a" }, { project: inner, name: "inner", sessionId: "b" }];
  assert.equal(pickStandIn(markers, path.join(inner, "x"), "c").name, "inner");
  assert.equal(pickStandIn(markers, path.join(outer, "y"), "c").name, "outer");
  assert.equal(pickStandIn(markers, path.join(inner, "x"), "b").name, "outer", "the inner stand-in's own dialog goes to the outer one");
  assert.equal(pickStandIn(markers, path.resolve("/elsewhere"), "c"), null);
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

test("askLive: a live hook, a 1.1.0 ask within its 10 minutes, nothing older than a day", () => {
  const now = Date.now();
  assert.equal(askLive({ createdAt: now, hookPid: process.pid }, { now }), true);
  assert.equal(askLive({ createdAt: now, hookPid: DEAD_PID }, { now }), false);
  assert.equal(askLive({ createdAt: now - 5 * MINUTE }, { now }), true);
  assert.equal(askLive({ createdAt: now - 12 * MINUTE }, { now }), false);
  assert.equal(askLive({ createdAt: now - 25 * 60 * MINUTE, hookPid: process.pid }, { now }), false);
});

test("pendingAsks: routed at read time, so a stand-in that comes on later sees dialogs already open", () => {
  const home = tmp();
  const project = path.join(home, "app");
  const now = Date.now();
  const a = createAsk({ home, sessionId: "x", cwd: path.join(project, "web"), questions: QUESTIONS, now });
  const own = createAsk({ home, sessionId: "s-me", cwd: project, questions: QUESTIONS, now: now + 1 });
  const outside = createAsk({ home, sessionId: "y", cwd: path.join(home, "shop"), questions: QUESTIONS, now: now + 2 });
  const me = { name: "me", sessionId: "s-me", project };
  assert.deepEqual(pendingAsks({ home, standIn: me, now }).map((x) => x.id), [], "nobody is on duty yet");
  activate({ home, project, name: "me", sessionId: "s-me", pid: process.pid });
  assert.deepEqual(pendingAsks({ home, standIn: me, now }).map((x) => x.id), [a], "not its own, not another project's");
  assert.deepEqual(pendingAsks({ home, now }).map((x) => x.id), [a, own, outside], "without a stand-in: every open ask");
  writeAnswer(a, { answers: {} }, home);
  assert.deepEqual(pendingAsks({ home, standIn: me, now }).map((x) => x.id), []);
  assert.deepEqual(readAnswer(a, home), { answers: {} });
});

test("pendingAsks: a nested stand-in takes its own project's asks", () => {
  const home = tmp();
  const outer = path.join(home, "work");
  const inner = path.join(outer, "app");
  activate({ home, project: outer, name: "outer", sessionId: "o", pid: process.pid });
  activate({ home, project: inner, name: "inner", sessionId: "i", pid: process.pid });
  const inInner = createAsk({ home, sessionId: "x", cwd: inner, questions: QUESTIONS });
  const inOuter = createAsk({ home, sessionId: "x", cwd: path.join(outer, "docs"), questions: QUESTIONS });
  assert.deepEqual(pendingAsks({ home, standIn: { sessionId: "i" } }).map((x) => x.id), [inInner]);
  assert.deepEqual(pendingAsks({ home, standIn: { sessionId: "o" } }).map((x) => x.id), [inOuter]);
});

test("pendingAsks: a session asking from a folder added to it is still its project's", () => {
  const home = tmp();
  const project = path.join(home, "macore");
  const added = path.join(home, "bot-facebook");
  activate({ home, project, name: "me", sessionId: "s-me", pid: process.pid });
  const me = { sessionId: "s-me" };
  const sessions = [{ sessionId: "x", cwd: project }, { sessionId: "y", cwd: added }];
  const saved = createAsk({ home, sessionId: "z", cwd: added, dirs: [project], questions: QUESTIONS });
  // An ask written by a 1.2.0 hook has no `dirs`; the session file gives the root.
  const legacy = path.join(home, "answer-for-me", "asks", "legacy-1.json");
  fs.writeFileSync(legacy, JSON.stringify({
    id: "legacy-1", sessionId: "x", cwd: added, questions: QUESTIONS, hookPid: process.pid, createdAt: Date.now() + 1,
  }));
  const foreign = createAsk({ home, sessionId: "y", cwd: added, questions: QUESTIONS });
  assert.deepEqual(pendingAsks({ home, standIn: me, sessions }).map((a) => a.id), [saved, "legacy-1"]);
  assert.equal(pendingAsks({ home, standIn: me, sessions }).some((a) => a.id === foreign), false,
    "a session rooted in the other repo is not this project's");
  assert.deepEqual(askDirs({ sessionId: "x", cwd: added }, sessions), [added, project]);
});

test("pendingAsks: leftovers of dead hooks and old outcomes are removed, unless sweep is off", () => {
  const home = tmp();
  const now = Date.now();
  const dir = path.join(home, "answer-for-me", "asks");
  const dead = createAsk({ home, sessionId: "x", cwd: home, questions: QUESTIONS, hookPid: DEAD_PID, now });
  const legacy = createAsk({ home, sessionId: "x", cwd: home, questions: QUESTIONS, hookPid: null, now: now - 20 * MINUTE });
  closeAsk("old", home, "delivered", now - 2 * 60 * MINUTE);
  closeAsk("fresh", home, "delivered", now);
  assert.deepEqual(pendingAsks({ home, now, sweep: false }), []);
  assert.equal(fs.existsSync(path.join(dir, `${dead}.json`)), true, "sweep:false only reads");
  assert.deepEqual(pendingAsks({ home, now }), []);
  assert.equal(fs.existsSync(path.join(dir, `${dead}.json`)), false);
  assert.equal(fs.existsSync(path.join(dir, `${legacy}.json`)), false);
  assert.equal(readOutcome("old", home), null);
  assert.equal(readOutcome("fresh", home).outcome, "delivered");
});

test("allowOutput: a PermissionRequest allow with the answers and a note saying who answered", () => {
  const out = allowOutput(QUESTIONS, { "Which color?": "Blue", "Which sizes?": "M" }, "stand-in-1");
  const h = out.hookSpecificOutput;
  assert.equal(h.hookEventName, "PermissionRequest");
  assert.equal(h.decision.behavior, "allow");
  assert.deepEqual(h.decision.updatedInput.answers, { "Which color?": "Blue", "Which sizes?": "M" });
  assert.deepEqual(h.decision.updatedInput.questions, QUESTIONS);
  assert.match(h.decision.updatedInput.annotations["Which color?"].notes, /stand-in-1.*not typed by the user/);
});

// ---- the hook, end to end against a temp Claude home ----

function startGuard(home, input, env = {}) {
  const p = spawn(process.execPath, [GUARD], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: home, ANSWER_FOR_ME_POLL_MS: "50", ...env },
  });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  const done = new Promise((resolve) => p.on("exit", (code) => resolve({ code, out })));
  p.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  return { done, pid: p.pid };
}

async function waitForAsk(home, pred = () => true) {
  for (let i = 0; i < 100; i++) {
    const ask = pendingAsks({ home }).find(pred);
    if (ask) return ask;
    await sleep(50);
  }
  throw new Error("the hook wrote no ask");
}

function setup() {
  const home = tmp();
  const project = path.join(home, "app");
  fs.mkdirSync(project, { recursive: true });
  const transcript = path.join(home, "asker.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({
    type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "AskUserQuestion", input: { questions: QUESTIONS } }] },
  }) + "\n");
  const input = {
    hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", session_id: "asker", cwd: project,
    transcript_path: transcript, tool_input: { questions: QUESTIONS },
  };
  return { home, project, transcript, input };
}

test("ask-guard: a dialog opened before the stand-in went on duty still gets its answer", async () => {
  const { home, project, input } = setup();
  const run = startGuard(home, input);
  const ask = await waitForAsk(home);
  assert.equal(ask.sessionId, "asker");
  assert.equal(ask.hookPid, run.pid);
  await sleep(300); // the dialog sits there with nobody on duty
  activate({ home, project, name: "me", sessionId: "s-me", pid: process.pid });
  assert.deepEqual(pendingAsks({ home, standIn: { sessionId: "s-me" } }).map((a) => a.id), [ask.id]);
  writeAnswer(ask.id, { answers: resolvePicks(ask.questions, { 1: [1], 2: [2, 3] }), by: "me" }, home);
  const r = await run.done;
  assert.equal(r.code, 0);
  const h = JSON.parse(r.out).hookSpecificOutput;
  assert.equal(h.decision.behavior, "allow");
  assert.deepEqual(h.decision.updatedInput.answers, { "Which color?": "Red", "Which sizes?": "M, L" });
  assert.match(h.decision.updatedInput.annotations["Which color?"].notes, /^Answered by me,/);
  assert.equal(readOutcome(ask.id, home).outcome, "delivered");
  assert.deepEqual(pendingAsks({ home }), []);
});

test("ask-guard: saves the session's root when it asks from an added folder", async () => {
  const { home, project, input } = setup();
  const added = path.join(home, "other-repo");
  fs.mkdirSync(path.join(home, "sessions"));
  fs.writeFileSync(path.join(home, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "asker", name: "asker-1", cwd: project }));
  const run = startGuard(home, { ...input, cwd: added });
  const ask = await waitForAsk(home);
  assert.deepEqual(ask.dirs, [added, project]);
  activate({ home, project, name: "me", sessionId: "s-me", pid: process.pid });
  assert.deepEqual(pendingAsks({ home, standIn: { sessionId: "s-me" }, sessions: [] }).map((a) => a.id), [ask.id]);
  writeAnswer(ask.id, { pass: true }, home);
  assert.deepEqual(await run.done, { code: 0, out: "" });
});

test("ask-guard: the user answers in the dialog first -> the hook leaves quietly", async () => {
  const { home, transcript, input } = setup();
  const run = startGuard(home, input);
  const ask = await waitForAsk(home);
  fs.appendFileSync(transcript, JSON.stringify({
    type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "The user answered" }] },
  }) + "\n");
  assert.deepEqual(await run.done, { code: 0, out: "" });
  assert.equal(readOutcome(ask.id, home).outcome, "answered-in-dialog");
  assert.deepEqual(pendingAsks({ home }), []);
});

test("ask-guard: pass and timeout leave the dialog to the user", async () => {
  const { home, input } = setup();
  const passing = startGuard(home, input);
  const ask = await waitForAsk(home);
  writeAnswer(ask.id, { pass: true }, home);
  assert.deepEqual(await passing.done, { code: 0, out: "" });
  assert.equal(readOutcome(ask.id, home).outcome, "passed");

  assert.deepEqual(await startGuard(home, input, { ANSWER_FOR_ME_WAIT_SECONDS: "1" }).done, { code: 0, out: "" });
  assert.deepEqual(pendingAsks({ home }), []);
});

test("ask-guard: stops when the asking session's process is gone", async () => {
  const { home, input } = setup();
  fs.mkdirSync(path.join(home, "sessions"));
  fs.writeFileSync(path.join(home, "sessions", `${DEAD_PID}.json`), JSON.stringify({ pid: DEAD_PID, sessionId: "asker", name: "asker-1" }));
  const r = await startGuard(home, input).done;
  assert.deepEqual(r, { code: 0, out: "" });
  const done = fs.readdirSync(path.join(home, "answer-for-me", "asks")).filter((n) => n.endsWith(".done.json"));
  assert.equal(done.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "answer-for-me", "asks", done[0]), "utf8")).outcome, "session-gone");
});

test("ask-guard: in a subagent it waits only when a stand-in is already on", async () => {
  const { home, project, input } = setup();
  const sub = { ...input, agent_id: "agent-1" };
  assert.deepEqual(await startGuard(home, sub).done, { code: 0, out: "" });
  assert.equal(fs.existsSync(path.join(home, "answer-for-me", "asks")), false, "no ask written");

  activate({ home, project, name: "me", sessionId: "s-me", pid: process.pid });
  const run = startGuard(home, sub);
  const ask = await waitForAsk(home);
  assert.equal(ask.agentId, "agent-1");
  writeAnswer(ask.id, { answers: resolvePicks(ask.questions, { 1: [2], 2: [1] }) }, home);
  const h = JSON.parse((await run.done).out).hookSpecificOutput;
  assert.deepEqual(h.decision.updatedInput.answers, { "Which color?": "Blue", "Which sizes?": "S" });
  assert.match(h.decision.updatedInput.annotations["Which color?"].notes, /^Answered by me,/, "the note names the stand-in on duty");
});

test("ask-guard: other tools, answered input and bad input never fail the session", async () => {
  const home = tmp();
  assert.deepEqual(await startGuard(home, { tool_name: "Bash" }).done, { code: 0, out: "" });
  const answered = { tool_name: "AskUserQuestion", session_id: "x", cwd: home, tool_input: { questions: QUESTIONS, answers: { "Which color?": "Red" } } };
  assert.deepEqual(await startGuard(home, answered).done, { code: 0, out: "" });
  assert.equal((await startGuard(home, "not json").done).code, 0);
  assert.equal(fs.existsSync(path.join(home, "answer-for-me", "asks")), false);
});
