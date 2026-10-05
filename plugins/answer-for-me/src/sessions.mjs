// sessions.mjs — which Claude Code sessions are live, which project each
// belongs to, and what each one is waiting on.
//
// Read-only. It reads Claude Code's own files and writes nothing:
//   <claude home>/sessions/<pid>.json          one per running session (name, sessionId, cwd, status)
//   <claude home>/projects/<slug>/<sid>.jsonl  that session's transcript
// A session file can outlive its process (a crash), so a reader checks `pid`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function claudeHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

// Signal 0 only checks. On Windows libuv opens the process and reads its exit
// code; it does not terminate it (Python's os.kill(pid, 0) would).
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function normDir(p, platform) {
  let s = path.resolve(p || "").replace(/[\\/]+$/, "");
  if (platform === "win32") s = s.toLowerCase();
  return s;
}

// Is `cwd` the project root itself or a folder inside it?
export function inScope(cwd, root, platform = process.platform) {
  if (!cwd || !root) return false;
  const c = normDir(cwd, platform);
  const r = normDir(root, platform);
  return c === r || c.startsWith(r + path.sep) || c.startsWith(r + "/");
}

// Every session file that parses, live or not.
export function readSessions(home = claudeHome()) {
  const dir = path.join(home, "sessions");
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const n of names) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"))); } catch { /* mid-write; next run sees it */ }
  }
  return out;
}

export function findTranscript(sessionId, home = claudeHome()) {
  if (!sessionId) return null;
  const root = path.join(home, "projects");
  let slugs = [];
  try { slugs = fs.readdirSync(root); } catch { return null; }
  for (const slug of slugs) {
    const p = path.join(root, slug, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c && c.type === "text").map((c) => c.text || "").join("\n");
}

export function clip(s, n) {
  s = s || "";
  return s.length <= n ? s : `${s.slice(0, n)} …(+${s.length - n} chars)`;
}

// Summarise a transcript (its JSONL text): the last prompt a person typed, the
// last thing the assistant said, AskUserQuestion calls still without an answer,
// and the last `tailN` events.
export function analyseTranscript(jsonl, tailN = 4) {
  let lastPrompt = null;
  let lastText = null;
  const asks = new Map();
  const answered = new Set();
  const tail = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if ((e.type !== "user" && e.type !== "assistant") || e.isMeta) continue;
    const content = e.message?.content;
    if (e.type === "user") {
      // Tool results, task notifications and peer messages are user turns
      // too; a person's prompt is the text that is not a <tag>.
      const t = textOf(content).trim();
      if (t && !t.startsWith("<")) lastPrompt = t;
    }
    if (typeof content === "string") {
      tail.push(`[${e.type}] ${clip(content, 400)}`);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type === "tool_use") {
        if (c.name === "AskUserQuestion") asks.set(c.id, c.input);
        tail.push(`[tool_use ${c.name}] ${clip(JSON.stringify(c.input), 300)}`);
      } else if (c.type === "tool_result") {
        answered.add(c.tool_use_id);
        let r = c.content;
        if (Array.isArray(r)) r = r.map((x) => x?.text || "").join(" ");
        tail.push(`[tool_result] ${clip(String(r ?? ""), 200)}`);
      } else if (c.type === "text" && e.type === "assistant") {
        lastText = c.text || "";
        tail.push(`[assistant] ${clip(lastText, 400)}`);
      }
    }
  }
  const pending = [...asks].filter(([id]) => !answered.has(id)).map(([, input]) => input);
  return { lastPrompt, lastText, pending, tail: tail.slice(-tailN) };
}

// The live sessions to show: not this one, alive, inside `project` unless
// `all`, and only `names` when given. `skipped` counts live sessions of other
// projects, so the caller can say they exist without showing them.
export function selectSessions(sessions, { project, all = false, exclude = "", names = [], alive = pidAlive, platform = process.platform } = {}) {
  const shown = [];
  let skipped = 0;
  for (const s of sessions) {
    if (!s || s.name === exclude) continue;
    if (names.length && !names.includes(s.name)) continue;
    if (!alive(s.pid)) continue;
    if (!all && !inScope(s.cwd, project, platform)) { skipped++; continue; }
    shown.push(s);
  }
  shown.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { shown, skipped };
}
