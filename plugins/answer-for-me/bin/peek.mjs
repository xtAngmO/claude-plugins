#!/usr/bin/env node
// peek.mjs — the other live Claude Code sessions of this project, and what
// each is waiting on.
//
//   node peek.mjs --exclude <this-session-name> [--project <dir>] [--names a,b] [-n 4] [--all]
//
// --project defaults to the current directory. --all also shows other
// projects' sessions; use it only when the user named them.
import fs from "node:fs";
import { analyseTranscript, claudeHome, clip, findTranscript, readSessions, selectSessions } from "../src/sessions.mjs";

const USAGE = "usage: peek.mjs --exclude <this-session-name> [--project <dir>] [--names a,b] [-n 4] [--all]";

function parseArgs(argv) {
  const a = { project: process.cwd(), all: false, exclude: "", names: [], n: 4 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i] ?? "";
    if (k === "--project") a.project = v();
    else if (k === "--all") a.all = true;
    else if (k === "--exclude") a.exclude = v();
    else if (k === "--names") a.names = v().split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "-n") a.n = Number(v()) || 4;
    else if (k === "-h" || k === "--help") { console.log(USAGE); process.exit(0); }
    else { console.error(`unknown argument: ${k}\n${USAGE}`); process.exit(2); }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const home = claudeHome();
const { shown, skipped } = selectSessions(readSessions(home), args);
const now = Date.now();
const rule = "=".repeat(100);
const indent = (s, pad) => String(s ?? "").replace(/\n/g, `\n${pad}`);

for (const s of shown) {
  const mins = Math.round((now - (s.statusUpdatedAt || s.updatedAt || now)) / 60000);
  console.log(rule);
  console.log(`${s.name}  [${s.status ?? "?"} ${mins}m]  cwd=${s.cwd}  sid=${s.sessionId}`);
  const tp = findTranscript(s.sessionId, home);
  if (!tp) { console.log("  (no transcript yet)"); continue; }
  const r = analyseTranscript(fs.readFileSync(tp, "utf8"), args.n);
  console.log(`  LAST USER PROMPT: ${indent(clip(r.lastPrompt, 600), "    ")}`);
  for (const q of r.pending) console.log(`  >>> WAITING ON AskUserQuestion: ${clip(JSON.stringify(q), 2000)}`);
  console.log("  TAIL:");
  for (const t of r.tail) console.log(`    ${indent(t, "      ")}`);
  console.log("  LAST ASSISTANT TEXT (full):");
  console.log(`    ${indent(clip(r.lastText, 6000), "    ")}`);
}
console.log(rule);
console.log(`${shown.length} session(s) in scope${skipped ? `, ${skipped} live session(s) in other projects not shown` : ""}`);
