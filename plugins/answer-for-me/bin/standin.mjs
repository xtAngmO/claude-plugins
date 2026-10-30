#!/usr/bin/env node
// standin.mjs — the stand-in session's side of answering dialogs.
//
//   on   --name <this-session-name> [--project <dir>]   start covering this project's dialogs
//   off  [--project <dir>]                              stop (dialogs are the user's alone again)
//   status                                              live stand-ins and every open dialog
//   watch --name <this-session-name>                    one line per open dialog, the ones already
//                                                       open first (run under Monitor)
//   show <id>                                           the ask's questions, numbered
//   answer <id> 1=2 2=1,3 3=:free text                  pick options by number, or give text
//   answer <id> --file <answers.json>                   {"1": [2], "2": "text"} (use for non-ASCII text)
//   pass <id>                                           leave this one to the user
//
// `answer` and `pass` wait a few seconds for the asking session's hook and say
// how it ended: delivered (the dialog closed with your answer), or the user
// had already answered, or the session is gone.
import fs from "node:fs";
import { claudeHome, readSessions } from "../src/sessions.mjs";
import {
  activate, activeFor, askDirs, askExists, deactivate, listActive, parsePickArgs, pendingAsks, readAsk, readOutcome,
  resolvePicks, writeAnswer,
} from "../src/standin.mjs";

const home = claudeHome();
const [cmd, ...rest] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function opt(name, fallback) {
  const i = rest.indexOf(name);
  if (i < 0) return fallback;
  const v = rest[i + 1];
  rest.splice(i, 2);
  return v;
}

function die(msg) { console.error(msg); process.exit(1); }

function sessionByName(name) {
  if (!name) die("--name <this-session-name> is required (ListAgents: \"This session is <name>\")");
  const s = readSessions(home).find((x) => x.name === name);
  if (!s) die(`no session named "${name}" in ${home}/sessions`);
  return s;
}

function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

function describe(ask) {
  const lines = [`ask ${ask.id} from ${ask.sessionName || ask.sessionId} (${ask.cwd}), open since ${ago(ask.createdAt)}`];
  ask.questions.forEach((q, i) => {
    lines.push(`  ${i + 1}. ${q.question}${q.multiSelect ? "  [multi-select]" : ""}`);
    (q.options || []).forEach((o, j) => lines.push(`     ${j + 1}) ${o.label}${o.description ? ` — ${o.description}` : ""}`));
  });
  return lines.join("\n");
}

function findAsk(id) {
  const ask = readAsk(id, home);
  if (ask) return ask;
  const done = readOutcome(id, home);
  die(done ? `ask "${id}" is closed: ${explain(done.outcome)}` : `no open ask "${id}" (answered, passed, or its session gave up)`);
}

function explain(outcome) {
  switch (outcome) {
    case "delivered": return "delivered; the dialog closed with this answer";
    case "passed": return "passed; the dialog stays on the user's screen";
    case "answered-in-dialog": return "the user had already answered in the dialog, so this answer was not used";
    case "session-gone": return "the asking session has exited";
    case "withdrawn": return "the ask was withdrawn";
    case "timeout": return "the hook stopped waiting; the dialog is the user's";
    default: return String(outcome);
  }
}

// The hook polls once a second; give it a few rounds to pick the file up.
// A 1.1.0 hook (sessions started before 1.2.0) leaves no outcome file; its ask
// just disappears once it has read the answer.
async function reportOutcome(id) {
  for (let i = 0; i < 16; i++) {
    const done = readOutcome(id, home);
    if (done) { console.log(explain(done.outcome)); return; }
    if (!askExists(id, home)) { console.log("picked up by the session's hook"); return; }
    await sleep(500);
  }
  console.log("written, but the hook has not picked it up yet; check `status`");
}

switch (cmd) {
  case "on": {
    const project = opt("--project", process.cwd());
    const s = sessionByName(opt("--name"));
    const m = activate({ home, project, name: s.name, sessionId: s.sessionId, pid: s.pid });
    console.log(`stand-in ${m.name} now answers dialogs of sessions under ${m.project}`);
    const open = pendingAsks({ home, standIn: m });
    if (open.length) console.log(`${open.length} dialog(s) already open; \`watch\` lists them first`);
    break;
  }
  case "off": {
    const project = opt("--project", process.cwd());
    console.log(deactivate({ home, project }) ? "stand-in off; dialogs are the user's alone again" : "no stand-in was on for this project");
    break;
  }
  case "status": {
    const act = listActive({ home });
    if (!act.length) console.log("no live stand-in");
    for (const m of act) console.log(`stand-in ${m.name} covers ${m.project} since ${new Date(m.since).toISOString()}`);
    for (const a of pendingAsks({ home })) {
      const who = activeFor({ home, cwd: askDirs(a, readSessions(home)), sessionId: a.sessionId })?.name;
      console.log(`${describe(a)}\n  -> ${who ? `stand-in ${who}` : "no stand-in covers it; the user's dialog"}`);
    }
    break;
  }
  case "watch": {
    const s = sessionByName(opt("--name"));
    const seen = new Set();
    for (;;) {
      for (const a of pendingAsks({ home, standIn: s })) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        const when = Date.now() - a.createdAt > 5000 ? ` (open since ${ago(a.createdAt)})` : "";
        console.log(`ASK ${a.id} from ${a.sessionName || a.sessionId}${when}: ${a.questions.map((q) => q.question).join(" | ")}`.replace(/\s+/g, " "));
      }
      await sleep(1000);
    }
  }
  case "show": {
    console.log(describe(findAsk(rest[0])));
    break;
  }
  case "answer": {
    const id = rest.shift();
    const ask = findAsk(id);
    const file = opt("--file");
    try {
      const picks = file ? JSON.parse(fs.readFileSync(file, "utf8")) : parsePickArgs(rest);
      const answers = resolvePicks(ask.questions, picks);
      const by = activeFor({ home, cwd: askDirs(ask, readSessions(home)), sessionId: ask.sessionId })?.name;
      writeAnswer(id, { answers, by, at: Date.now() }, home);
      for (const [q, a] of Object.entries(answers)) console.log(`${q} -> ${a}`);
    } catch (e) {
      die(`${e.message}\n\n${describe(ask)}`);
    }
    await reportOutcome(id);
    break;
  }
  case "pass": {
    findAsk(rest[0]);
    writeAnswer(rest[0], { pass: true, at: Date.now() }, home);
    await reportOutcome(rest[0]);
    break;
  }
  default:
    die("usage: standin.mjs on|off|status|watch|show|answer|pass (see the header of this file)");
}
