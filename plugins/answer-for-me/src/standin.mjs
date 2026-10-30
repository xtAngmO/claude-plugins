// standin.mjs — lets the stand-in session answer another session's
// AskUserQuestion dialog, also one that opened before the stand-in went on duty.
//
// A dialog blocks its session until someone picks an option, and a
// cross-session message is only read at the session's next tool round, so a
// message can't answer it. Instead a PermissionRequest hook (bin/ask-guard.mjs)
// runs in the asking session. Claude Code runs that hook alongside the open
// dialog, and whichever answers first wins:
//
//   1. The hook writes the questions to <home>/answer-for-me/asks/<id>.json the
//      moment the dialog opens, whether or not a stand-in is on, and waits.
//   2. A stand-in registers itself:  <home>/answer-for-me/active/<key>.json
//      (project root, its name, sessionId and pid). Every ask with a folder in
//      its project (the hook's cwd, or the asking session's root) is now its
//      own, including asks written before it came on.
//   3. The stand-in (watching asks/) writes asks/<id>.answer.json.
//   4. The hook returns `allow` with `updatedInput.answers`: the tool resolves
//      with those answers and the dialog closes. If the user answers in the
//      dialog first, or the session exits, the hook gives up. Either way it
//      leaves asks/<id>.done.json saying how it ended, then removes the ask.
//
// Every answer carries an annotation saying the stand-in gave it, so the
// asking session knows it was not typed by the user.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { claudeHome, inScope, pidAlive, readSessions } from "./sessions.mjs";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// 1.1.0's PreToolUse hook wrote asks without a hookPid and waited 10 minutes.
const LEGACY_WAIT = 11 * MINUTE;

export function baseDir(home = claudeHome()) { return path.join(home, "answer-for-me"); }
const activeDir = (home) => path.join(baseDir(home), "active");
const asksDir = (home) => path.join(baseDir(home), "asks");
const askFile = (home, id, kind = "") => path.join(asksDir(home), `${id}${kind}.json`);

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

function unlink(file) {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
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

// Of the live stand-in markers, the one that covers `cwd`, unless it is the
// asking session itself. The most specific project root wins when stand-ins
// are nested. `cwd` may be a list: a session that works in a folder added to
// it (the desktop app's "add folder") asks from that folder, while its own
// root is still the project's; a stand-in covering either one takes the ask.
export function pickStandIn(markers, cwd, sessionId, platform = process.platform) {
  const dirs = [].concat(cwd).filter(Boolean);
  const hits = markers
    .filter((m) => m.sessionId !== sessionId && dirs.some((d) => inScope(d, m.project, platform)))
    .sort((a, b) => b.project.length - a.project.length);
  return hits[0] || null;
}

export function activeFor({ home = claudeHome(), cwd, sessionId, alive = pidAlive, platform = process.platform }) {
  return pickStandIn(listActive({ home, alive }), cwd, sessionId, platform);
}

// Every folder an ask belongs to: the hook's cwd, the folders the hook saved
// (`dirs`, since 1.2.1), and the asking session's root from its session file.
// The last one also routes asks written by an older hook that saved only cwd.
export function askDirs(ask, sessions = []) {
  const own = sessions.find((s) => s.sessionId === ask.sessionId);
  return [...new Set([ask.cwd, ...(ask.dirs || []), own?.cwd].filter(Boolean))];
}

// Written by the hook when its dialog opens. `hookPid` lets a reader drop the
// ask of a hook that was killed before it could clean up.
export function createAsk({
  home = claudeHome(), sessionId, sessionName, sessionPid, agentId, cwd, dirs, questions, hookPid = process.pid,
  now = Date.now(),
}) {
  const id = `${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  writeJson(askFile(home, id), {
    id, sessionId, sessionName: sessionName || null, sessionPid: sessionPid || null, agentId: agentId || null,
    cwd, dirs: [...new Set([cwd, ...(dirs || [])].filter(Boolean))], questions, hookPid, createdAt: now,
  });
  return id;
}

export function readAsk(id, home = claudeHome()) { return readJson(askFile(home, id)); }
export function askExists(id, home = claudeHome()) { return fs.existsSync(askFile(home, id)); }
export function readAnswer(id, home = claudeHome()) { return readJson(askFile(home, id, ".answer")); }
export function readOutcome(id, home = claudeHome()) { return readJson(askFile(home, id, ".done")); }

export function writeAnswer(id, answer, home = claudeHome()) {
  writeJson(askFile(home, id, ".answer"), answer);
}

// Removes the ask and its answer. With `outcome`, first leaves <id>.done.json
// so the stand-in's `answer` can say whether its answer reached the session.
export function closeAsk(id, home = claudeHome(), outcome, now = Date.now()) {
  if (outcome) {
    try { writeJson(askFile(home, id, ".done"), { id, outcome, at: now }); } catch { /* best effort */ }
  }
  unlink(askFile(home, id));
  unlink(askFile(home, id, ".answer"));
}

// Is the hook that wrote this ask still waiting on it?
export function askLive(ask, { now = Date.now(), alive = pidAlive } = {}) {
  if (!ask || now - ask.createdAt > DAY) return false;
  if (ask.hookPid == null) return now - ask.createdAt <= LEGACY_WAIT;
  return alive(ask.hookPid);
}

// Asks still waiting for an answer, oldest first. With `standIn`, only the
// ones routed to it: one of their folders (askDirs) is in its project, they
// are not its own, and no more specific stand-in covers them (`markers`: the
// live stand-ins; `sessions`: the session files). An ask whose hook is gone is
// a leftover and is removed, as are outcome files older than an hour;
// `sweep: false` only reads.
export function pendingAsks({
  home = claudeHome(), standIn, markers, sessions, now = Date.now(), alive = pidAlive, platform = process.platform,
  sweep = true,
} = {}) {
  let names = [];
  try { names = fs.readdirSync(asksDir(home)); } catch { return []; }
  if (standIn && !markers) markers = listActive({ home, alive });
  if (standIn && !sessions) sessions = readSessions(home);
  const out = [];
  for (const n of names) {
    if (n.endsWith(".done.json")) {
      const done = readJson(path.join(asksDir(home), n));
      if (sweep && (!done || now - done.at > HOUR)) unlink(path.join(asksDir(home), n));
      continue;
    }
    if (!n.endsWith(".json") || n.endsWith(".answer.json")) continue;
    const ask = readJson(path.join(asksDir(home), n));
    if (!ask) continue;
    if (!askLive(ask, { now, alive })) { if (sweep) closeAsk(ask.id, home); continue; }
    if (fs.existsSync(askFile(home, ask.id, ".answer"))) continue;
    if (standIn && pickStandIn(markers, askDirs(ask, sessions), ask.sessionId, platform)?.sessionId !== standIn.sessionId) {
      continue;
    }
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

export function standInNote(standInName) {
  return `Answered by ${standInName || "a stand-in session"}, the user's stand-in session (/answer-for-me), not typed by the user.`;
}

// What the PermissionRequest hook prints once the stand-in answered. The tool
// result shows each answer's annotation notes, which is how the asking model
// learns who answered (checked on 2.1.296).
export function allowOutput(questions, answers, standInName) {
  const note = standInNote(standInName);
  const annotations = {};
  for (const q of questions) annotations[q.question] = { notes: note };
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput: { questions, answers, annotations } },
    },
  };
}
