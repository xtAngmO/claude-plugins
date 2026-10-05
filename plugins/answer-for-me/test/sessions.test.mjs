import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyseTranscript, findTranscript, inScope, pidAlive, readSessions, selectSessions } from "../src/sessions.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "answer-for-me-"));
const jsonl = (...rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const user = (content, extra = {}) => ({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (content) => ({ type: "assistant", message: { role: "assistant", content } });

test("inScope: the root and folders inside it, not siblings that share a prefix", () => {
  assert.equal(inScope("/w/app", "/w/app", "linux"), true);
  assert.equal(inScope("/w/app/web", "/w/app", "linux"), true);
  assert.equal(inScope("/w/app/", "/w/app", "linux"), true);
  assert.equal(inScope("/w/app-old", "/w/app", "linux"), false);
  assert.equal(inScope("/w", "/w/app", "linux"), false);
  assert.equal(inScope(undefined, "/w/app", "linux"), false);
});

test("inScope: Windows paths compare without case", { skip: process.platform !== "win32" }, () => {
  assert.equal(inScope("C:\\Users\\Me\\Repo\\web", "c:\\users\\me\\repo", "win32"), true);
  assert.equal(inScope("C:\\Users\\Me\\Repo2", "c:\\users\\me\\repo", "win32"), false);
});

test("pidAlive: this process is alive, a missing pid is not", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(undefined), false);
});

test("selectSessions: drops self, dead and other-project sessions, and counts the latter", () => {
  const sessions = [
    { name: "me", pid: 1, cwd: "/w/app" },
    { name: "b", pid: 2, cwd: "/w/app/web" },
    { name: "a", pid: 3, cwd: "/w/app" },
    { name: "dead", pid: 4, cwd: "/w/app" },
    { name: "other", pid: 5, cwd: "/w/shop" },
  ];
  const alive = (pid) => pid !== 4;
  const r = selectSessions(sessions, { project: "/w/app", exclude: "me", alive, platform: "linux" });
  assert.deepEqual(r.shown.map((s) => s.name), ["a", "b"]);
  assert.equal(r.skipped, 1);

  const all = selectSessions(sessions, { project: "/w/app", exclude: "me", all: true, alive, platform: "linux" });
  assert.deepEqual(all.shown.map((s) => s.name), ["a", "b", "other"]);

  const named = selectSessions(sessions, { project: "/w/app", names: ["b"], alive, platform: "linux" });
  assert.deepEqual(named.shown.map((s) => s.name), ["b"]);
});

test("analyseTranscript: last typed prompt, last assistant text, unanswered AskUserQuestion", () => {
  const t = jsonl(
    user("fix the login page"),
    assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
    user([{ type: "tool_result", tool_use_id: "t1", content: "a b c" }]),
    user("<task-notification>done</task-notification>"),
    user("meta stuff", { isMeta: true }),
    assistant([{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Old?" }] } }]),
    user([{ type: "tool_result", tool_use_id: "q1", content: "answered" }]),
    assistant([{ type: "text", text: "Done. Push it?" }]),
    assistant([{ type: "tool_use", id: "q2", name: "AskUserQuestion", input: { questions: [{ question: "Which design?" }] } }]),
    "not json",
  );
  const r = analyseTranscript(t, 3);
  assert.equal(r.lastPrompt, "fix the login page");
  assert.equal(r.lastText, "Done. Push it?");
  assert.deepEqual(r.pending, [{ questions: [{ question: "Which design?" }] }]);
  assert.equal(r.tail.length, 3);
  assert.match(r.tail.at(-1), /^\[tool_use AskUserQuestion\]/);
});

test("readSessions + findTranscript read a Claude home laid out like the real one", () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, "sessions"));
  fs.mkdirSync(path.join(home, "projects", "slug-a"), { recursive: true });
  fs.writeFileSync(path.join(home, "sessions", "11.json"), JSON.stringify({ pid: 11, sessionId: "s1", name: "x" }));
  fs.writeFileSync(path.join(home, "sessions", "12.json"), "{ half written");
  fs.writeFileSync(path.join(home, "projects", "slug-a", "s1.jsonl"), "");
  assert.deepEqual(readSessions(home).map((s) => s.sessionId), ["s1"]);
  assert.equal(findTranscript("s1", home), path.join(home, "projects", "slug-a", "s1.jsonl"));
  assert.equal(findTranscript("nope", home), null);
  assert.deepEqual(readSessions(path.join(home, "missing")), []);
});
