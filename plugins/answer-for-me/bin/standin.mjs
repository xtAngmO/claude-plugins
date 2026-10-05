#!/usr/bin/env node
// standin.mjs — the stand-in session's side of answering dialogs.
//
//   on   --name <this-session-name> [--project <dir>]   start covering this project's dialogs
//   off  [--project <dir>]                              stop (dialogs open for the user again)
//   status                                              live stand-ins and asks waiting
//   watch --name <this-session-name>                    one line per new ask (run under Monitor)
//   show <id>                                           the ask's questions, numbered
//   answer <id> 1=2 2=1,3 3=:free text                  pick options by number, or give text
//   answer <id> --file <answers.json>                   {"1": [2], "2": "text"} (use for non-ASCII text)
//   pass <id>                                           let the user answer this one in the dialog
import fs from "node:fs";
import { claudeHome, readSessions } from "../src/sessions.mjs";
import {
  activate, deactivate, listActive, parsePickArgs, pendingAsks, readAsk, resolvePicks, writeAnswer,
} from "../src/standin.mjs";

const home = claudeHome();
const [cmd, ...rest] = process.argv.slice(2);

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

function describe(ask) {
  const lines = [`ask ${ask.id} from ${ask.sessionName || ask.sessionId} (${ask.cwd})`];
  ask.questions.forEach((q, i) => {
    lines.push(`  ${i + 1}. ${q.question}${q.multiSelect ? "  [multi-select]" : ""}`);
    (q.options || []).forEach((o, j) => lines.push(`     ${j + 1}) ${o.label}${o.description ? ` — ${o.description}` : ""}`));
  });
  return lines.join("\n");
}

function findAsk(id) {
  const ask = readAsk(id, home);
  if (!ask) die(`no waiting ask "${id}" (answered, passed, or its session gave up)`);
  return ask;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

switch (cmd) {
  case "on": {
    const project = opt("--project", process.cwd());
    const s = sessionByName(opt("--name"));
    const m = activate({ home, project, name: s.name, sessionId: s.sessionId, pid: s.pid });
    console.log(`stand-in ${m.name} now answers dialogs of sessions under ${m.project}`);
    break;
  }
  case "off": {
    const project = opt("--project", process.cwd());
    console.log(deactivate({ home, project }) ? "stand-in off; dialogs open for the user again" : "no stand-in was on for this project");
    break;
  }
  case "status": {
    const act = listActive({ home });
    if (!act.length) console.log("no live stand-in");
    for (const m of act) console.log(`stand-in ${m.name} covers ${m.project} since ${new Date(m.since).toISOString()}`);
    for (const a of pendingAsks({ home })) console.log(describe(a));
    break;
  }
  case "watch": {
    const s = sessionByName(opt("--name"));
    const seen = new Set();
    for (;;) {
      for (const a of pendingAsks({ home, standInSessionId: s.sessionId })) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        console.log(`ASK ${a.id} from ${a.sessionName || a.sessionId}: ${a.questions.map((q) => q.question).join(" | ")}`.replace(/\s+/g, " "));
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
    let picks;
    try {
      picks = file ? JSON.parse(fs.readFileSync(file, "utf8")) : parsePickArgs(rest);
      const answers = resolvePicks(ask.questions, picks);
      writeAnswer(id, { answers, at: Date.now() }, home);
      for (const [q, a] of Object.entries(answers)) console.log(`${q} -> ${a}`);
    } catch (e) {
      die(`${e.message}\n\n${describe(ask)}`);
    }
    break;
  }
  case "pass": {
    findAsk(rest[0]);
    writeAnswer(rest[0], { pass: true, at: Date.now() }, home);
    console.log("passed; the user gets the dialog");
    break;
  }
  default:
    die("usage: standin.mjs on|off|status|watch|show|answer|pass (see the header of this file)");
}
