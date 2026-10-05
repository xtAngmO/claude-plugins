// standin.mjs — lets the stand-in session answer another session's
// AskUserQuestion dialog.
//
// A dialog blocks its session until someone picks an option, and a
// cross-session message is only read at the session's next tool round, so a
// message can't answer it. Instead a PreToolUse hook (bin/ask-guard.mjs) runs
// in the asking session before the dialog opens:
//
//   1. The stand-in registers itself:  <home>/answer-for-me/active/<key>.json
//      (project root, its name, sessionId and pid).
//   2. The hook in another session of that project writes the questions to
//      <home>/answer-for-me/asks/<id>.json and waits.
//   3. The stand-in (watching asks/) writes asks/<id>.answer.json.
//   4. The hook returns `allow` with `updatedInput.answers`, so the tool
//      resolves with those answers and no dialog opens. On "pass" or timeout
//      the hook says nothing and the user gets the normal dialog.
//
// Every answer carries an annotation saying the stand-in gave it, so the
// asking session knows it was not typed by the user.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { claudeHome, inScope, pidAlive } from "./sessions.mjs";

const DAY = 24 * 60 * 60 * 1000;

export function baseDir(home = claudeHome()) { return path.join(home, "answer-for-me"); }
const activeDir = (home) => path.join(baseDir(home), "active");
const asksDir = (home) => path.join(baseDir(home), "asks");

function normKey(project, platform = process.platform) {
  let s = path.resolve(project).replace(/[\\/]+$/, "");
  if (platform === "win32") s = s.toLowerCase();
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

export function activate({ home = claudeHome(), project, name, sessionId, pid, now = Date.now() }) {
  const marker = { project: path.resolve(project), name, sessionId, pid, since: now };
  writeJson(path.join(activeDir(home), `${normKey(project)}.json`), marker);
  return marker;
}

export function deactivate({ home = claudeHome(), project }) {
  try { fs.unlinkSync(path.join(activeDir(home), `${normKey(project)}.json`)); return true; } catch { return false; }
}

export function listActive({ home = claudeHome(), alive = pidAlive } = {}) {
  let names = [];
  try { names = fs.readdirSync(activeDir(home)).filter((n) => n.endsWith(".json")); } catch { return []; }
  return names.map((n) => readJson(path.join(activeDir(home), n))).filter((m) => m && alive(m.pid));
}

// The live stand-in that covers `cwd`, unless it is the asking session itself.
// The most specific project root wins when stand-ins are nested.
export function activeFor({ home = claudeHome(), cwd, sessionId, alive = pidAlive, platform = process.platform }) {
  const hits = listActive({ home, alive })
    .filter((m) => m.sessionId !== sessionId && inScope(cwd, m.project, platform))
    .sort((a, b) => b.project.length - a.project.length);
  return hits[0] || null;
}

export function createAsk({ home = claudeHome(), standIn, sessionId, sessionName, cwd, questions, now = Date.now() }) {
  const id = `${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  writeJson(path.join(asksDir(home), `${id}.json`), {
    id, standIn: standIn.name, standInSessionId: standIn.sessionId, project: standIn.project,
    sessionId, sessionName: sessionName || null, cwd, questions, createdAt: now,
  });
  return id;
}

export function readAsk(id, home = claudeHome()) { return readJson(path.join(asksDir(home), `${id}.json`)); }
export function readAnswer(id, home = claudeHome()) { return readJson(path.join(asksDir(home), `${id}.answer.json`)); }

export function writeAnswer(id, answer, home = claudeHome()) {
  writeJson(path.join(asksDir(home), `${id}.answer.json`), answer);
}

export function closeAsk(id, home = claudeHome()) {
  for (const f of [`${id}.json`, `${id}.answer.json`]) {
    try { fs.unlinkSync(path.join(asksDir(home), f)); } catch { /* already gone */ }
  }
}

// Asks still waiting for an answer, oldest first. Files older than a day are
// leftovers of a hook that was killed; they are removed.
export function pendingAsks({ home = claudeHome(), standInSessionId, now = Date.now() } = {}) {
  let names = [];
  try { names = fs.readdirSync(asksDir(home)); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".json") || n.endsWith(".answer.json")) continue;
    const ask = readJson(path.join(asksDir(home), n));
    if (!ask) continue;
    if (now - ask.createdAt > DAY) { closeAsk(ask.id, home); continue; }
    if (standInSessionId && ask.standInSessionId !== standInSessionId) continue;
    if (fs.existsSync(path.join(asksDir(home), `${ask.id}.answer.json`))) continue;
    out.push(ask);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

// picks: { "<question number from 1>": [option numbers from 1] | "free text" }.
// Returns the `answers` map AskUserQuestion expects: question text -> label(s).
export function resolvePicks(questions, picks) {
  const answers = {};
  questions.forEach((q, i) => {
    const pick = picks[String(i + 1)];
    if (pick == null) throw new Error(`no answer for question ${i + 1}: ${q.question}`);
    if (typeof pick === "string") { answers[q.question] = pick; return; }
    const nums = Array.isArray(pick) ? pick : [pick];
    if (!q.multiSelect && nums.length !== 1) throw new Error(`question ${i + 1} takes one option`);
    const labels = nums.map((n) => {
      const opt = q.options?.[Number(n) - 1];
      if (!opt) throw new Error(`question ${i + 1} has no option ${n}`);
      return opt.label;
    });
    answers[q.question] = labels.join(", ");
  });
  return answers;
}

// Parse the CLI's "1=2 2=1,3 3=:free text" into picks.
export function parsePickArgs(args) {
  const picks = {};
  for (const a of args) {
    const m = /^(\d+)=(.*)$/s.exec(a);
    if (!m) throw new Error(`bad pick "${a}" (use <question>=<option>[,<option>] or <question>=:<text>)`);
    picks[m[1]] = m[2].startsWith(":") ? m[2].slice(1) : m[2].split(",").map((s) => Number(s.trim()));
  }
  return picks;
}

// What the PreToolUse hook prints once the stand-in answered.
export function allowOutput(questions, answers, standInName) {
  const note = `Answered by ${standInName}, the user's stand-in session (/answer-for-me), not typed by the user.`;
  const annotations = {};
  for (const q of questions) annotations[q.question] = { notes: note };
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: note,
      // The tool result only shows the picks; this is what tells the model.
      additionalContext: note,
      updatedInput: { questions, answers, annotations },
    },
  };
}
