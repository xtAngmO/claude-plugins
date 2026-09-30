---
name: parallel-subtasks
description: Decompose any non-trivial task into independent subtasks, track them in PROGRESS.md, and spawn one agent per subtask in a single message so they run concurrently. Use for features, refactors, multi-screen changes, or sweeps across files — whenever work splits into pieces that don't depend on each other.
---

# Decompose into parallel subtasks, then spawn N agents

The goal: **never do serially what independent agents can do at once.** A single self-contained edit
doesn't need this — but the moment work splits into pieces that don't depend on each other, fan them out.

## Before starting the work (the main agent does this)

1. **Decompose.** Break the request into the smallest **self-contained subtasks** — per screen, per
   component, per file, per layer (API client / state / UI), per design option, per area to research.

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
   dependent ones get sequenced after what they need.

4. **Spawn N agents — one per independent subtask — in a single message** so they run concurrently
   (sequential agent calls do **not** parallelize). Pick the agent type per job: read-only search/codebase
   mapping, design/planning, or implementation. Give each a tight, non-overlapping scope so two agents
   never edit the same file. **In every agent's prompt, tell it which `PROGRESS.md` line it owns and
   instruct it to update only that line** (`in-progress` on start, `done`/`blocked` on finish) — never to
   touch another agent's line, so the updates don't clobber each other. If subtasks touch the same files,
   either serialize them or give each its own git worktree.

5. **Sequence the dependent layer.** When the independent agents return, run the subtasks that depended on
   them (again fanning out any that are now mutually independent), adding their lines to `PROGRESS.md`
   first.

6. **Synthesize, update the handoff doc, then delete `PROGRESS.md`.** Once **every** line is `[x]`, the
   main agent collects the agents' results, reconciles them, runs the build/tests once over the combined
   change, and reports. Each agent's final message comes back to the main agent, not the user — relay what
   matters. If the combined change is a **major change** (not a hotfix), update the handoff doc (see the
   `project-handoff-doc` skill) **before** deleting `PROGRESS.md`. `PROGRESS.md` is a working scratchpad:
   **the main agent (never a sub-agent) deletes it only after all tasks are completed.** Sub-agents must
   never delete it (other agents may still be writing their lines).

## When NOT to fan out

A trivial one-file edit, work where every step depends on the previous one, or anything where splitting
would create merge conflicts you can't cleanly isolate. Use judgement — prefer parallel, but don't
manufacture subtasks that aren't really independent.

## Interplay with `preview-ui-first`

The 2–3 design options are independent by construction — spawn one agent per option so the mockups are
built **in parallel**, then present them together and wait for the pick. After the pick, parallelize the
implementation by component/file the same way.
