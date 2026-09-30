---
name: project-handoff-doc
description: Treat PROJECT.md as the single source of truth. Read it FIRST to get oriented instead of scanning the whole codebase; create it if missing; update it after any major change (new feature, package, API, schema, architecture, env/setting, CI/CD or deploy). Use at the start of unfamiliar work and whenever a major change lands.
---

# Maintain PROJECT.md — the handoff doc

`PROJECT.md` is the **single source of truth** for picking up work without scanning the tree. A handoff
doc that's out of date is worse than none — so reading it and keeping it accurate are two halves of the
same rule.

## Read it FIRST when you lack project background

Before scanning the codebase to orient yourself — what the project is, where things live, the stack, how
to build/run, the architecture, the conventions — **read `PROJECT.md`**. It exists precisely so you don't
have to grep the whole tree to get oriented. Only fall back to scanning when:

- `PROJECT.md` is **missing**, or
- you need detail it doesn't cover — then drill into the specific files/sections it points you to.

## Create it if missing

When the repo has no `PROJECT.md` (e.g. a fresh project), **write one** as a "read this first" handoff
doc that lets the next session pick up work without scanning the tree. Cover:

- what the project is · repo layout · tech stack · how to build/run/test
- architecture · main packages/modules · API/surface
- key conventions & gotchas
- a **Status & where to go next** section

Use numbered `##` sections, terse tables, and a lead "read this first" blockquote.

## Update it after a major change — not a hotfix

- **Major (DO update):** a new feature or screen/page; a new package/domain; new or changed API surface;
  a DB schema / migration; an architecture, auth/authz, or provider/driver change; a new env var or
  operator setting; a CI/CD or deploy change; a dependency **major** bump; a shift in status or
  "what's next".
- **Hotfix (skip):** a behaviour-neutral bug fix; a typo/copy tweak; a styling nudge; a comment/test-only
  edit; a fact-neutral refactor. When unsure, add a one-liner to the **Status** section rather than leave
  it stale.

## How

Edit the **specific section(s)** the change touches — repo layout, packages/modules, API surface,
architecture, build/deploy, conventions, and the **Status & where to go next** summary. Keep it terse and
in the document's existing voice; update the facts that changed, don't append a changelog.

In a parallel run the **main agent** makes this edit during synthesis (see the `parallel-subtasks` skill)
— sub-agents do **not** edit `PROJECT.md` concurrently (single coherent doc; concurrent writes clobber).
For a solo task, the agent that did the work updates it before reporting done.
