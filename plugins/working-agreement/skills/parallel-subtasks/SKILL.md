---
name: parallel-subtasks
description: Fan work out to parallel agents only when it pays — the user asks for parallel work, or there are 3+ truly independent subtasks that are each large. The default is to do the work in the main thread. When you do fan out, spawn the agents in a single message (max 3) and track them in PROGRESS.md.
---

# Fan out only when it pays, then spawn the agents together

Parallel agents buy wall-clock time with tokens. Spend them only when the time saved is worth it — the
default is to do the work yourself, in the main thread.

## Cost first

A subagent starts cold. It reloads `CLAUDE.md`, memory and the skill list, re-reads files the main agent
already has, and re-sends its whole context on every one of its turns. Measured over one heavy user's
week (2026-10-26): subagents were 60% of all usage, with ~2 subagent calls for every main-agent call and
an average subagent context of 267k tokens. Next to a comparable user who seldom fanned out, that was
most of a 5× difference in usage.

**Fan out only when all three hold** — or the user explicitly asks for parallel work:

1. **3+ subtasks with no shared files and no ordering between them.**
2. **Each is large** — roughly 20+ tool calls, or reading many files the main agent has not loaded.
3. **The main agent needs only a short result back,** not the details. If you would have to re-read what
   the agent read in order to use its result, do the work yourself.

**Never fan out for:** a lookup or grep, reading a few files, an edit to one or a few files, reviewing or
verifying your own change, writing mockups, running tests.

**Limits:** at most **3 agents** per fan-out unless the user asks for more. Subagents never spawn agents
of their own. Brief each agent narrowly and ask for a short report — paths and what changed — not file
dumps.

`reference-design-feature` keeps its one-agent-per-task fan-out: the user starts it on purpose, with a
URL, for a job that size.

## When you do fan out (the main agent does this)

1. **Decompose.** Break the request into **self-contained subtasks** that each clear the bar above — per
   screen, per layer (API client / state / UI), per area to research. Don't split finer than the bar.

2. **Create `PROGRESS.md`** at the repo root. One **checkbox item per subtask**, one per agent, with an
   owner tag and status. The main agent owns this file and is the only one that *creates* it; agents only
   *update their own line*. Template:

   ```markdown
   # PROGRESS — <task name>

   - [ ] **Agent 1 · <subtask>** — _status: pending_ · files: `path/…`
   - [ ] **Agent 2 · <subtask>** — _status: pending_ · files: `path/…`
   - [ ] **Agent 3 · <subtask>** — _status: pending_ · files: `path/…`
   ```
   Status flows `pending → in-progress → done` (or `blocked: <why>`); flip the checkbox to `[x]` on done.

3. **Map dependencies.** Mark which subtasks are **independent** (no shared output, no ordering
   requirement) vs. which must wait on another. Independent subtasks are the ones you parallelize;
   dependent ones get sequenced after what they need — or done by the main agent.

4. **Spawn the agents — one per independent subtask, within the limit above — in a single message** so
   they run concurrently (sequential agent calls do **not** parallelize). Pick the agent type per job:
   read-only search/codebase mapping, design/planning, or implementation. Give each a tight,
   non-overlapping scope so two agents never edit the same file. **In every agent's prompt, tell it which
   `PROGRESS.md` line it owns and instruct it to update only that line** (`in-progress` on start,
   `done`/`blocked` on finish) — never to touch another agent's line, so the updates don't clobber each
   other. If subtasks touch the same files, either serialize them or give each its own git worktree.

5. **Sequence the dependent layer.** When the independent agents return, do the subtasks that depended on
   them — in the main thread, unless they clear the bar again — adding their lines to `PROGRESS.md` first.

6. **Synthesize, update the handoff doc, then delete `PROGRESS.md`.** Once **every** line is `[x]`, the
   main agent collects the agents' results, reconciles them, runs the build/tests once over the combined
   change, and reports. Each agent's final message comes back to the main agent, not the user — relay what
   matters. If the combined change is a **major change** (not a hotfix), update the handoff doc (see the
   `project-handoff-doc` skill) **before** deleting `PROGRESS.md`. `PROGRESS.md` is a working scratchpad:
   **the main agent (never a sub-agent) deletes it only after all tasks are completed.** Sub-agents must
   never delete it (other agents may still be writing their lines).

## Interplay with `preview-ui-first`

Mockups are small, self-contained HTML files: the main agent writes the 2–3 options itself. Fan out only
if each option is a large multi-file build. After the pick, implement in the main thread unless the work
clears the bar above.
