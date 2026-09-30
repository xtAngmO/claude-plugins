---
name: reference-design-feature
description: Clone a reference website's STYLE (and optionally its FEATURES) with high fidelity using Playwright. Use when the user gives a reference site URL (e.g. "make it look like example.com", "copy the design of <url>", "copy the style and features of <url>") and wants its design tokens, components, interactions, and behaviors faithfully reproduced. Supports design-only or design+features scope. Captures the live site across pages/states/breakpoints, produces a COMPLETE task list, then spawns one agent per task in parallel.
---

# Reference-clone with Playwright

Reproduce a reference site faithfully. The user supplies the URL when triggering this skill; if none
is given, ask first. Clone design and behavior — not trademarks or logos (use placeholders). Chains
with `parallel-subtasks` (fan-out), `frontend-design` (aesthetic bar), and `test-every-change` (gate).

**Scope** — default is **style + features**. If the user wants **design only** ("copy just the
look/style"), skip the Features capture (`features.md`), the per-feature tasks, and
the behavior checks — do tokens / screens / motion / assets / structure → style tasks → visual diff
only.

## 1. Capture exhaustively (Playwright)

Install if needed (`npm i -D playwright && npx playwright install chromium`), then write a headless
`draft/ref-<site>/capture.mjs` and run it. Save everything under `draft/ref-<site>/` so Phase 2 has a
real spec, not a vibe. Capture:

- **Screens** — every major route × breakpoints (desktop 1440 / tablet 768 / mobile 375), full-page,
  plus interactive **states** (hover, focus, open menu/modal, tabs, loading, empty, error) driven via
  `page.hover/click/fill`.
- **Tokens** → `tokens.json` via `page.evaluate(getComputedStyle …)`: colors, fonts (display/body,
  weights, size scale), spacing, radii, shadows, z-index, breakpoints, and `:root` CSS vars.
- **Motion** — transition/animation duration + easing + page-load reveals + scroll effects.
- **Assets** — `ctx.on('response', …)` → fonts/icons/images/logos to `assets.json`.
- **Features** — forms/validation, search/filter, data/API endpoints, auth, routing, stateful
  widgets, framework → `features.md`.
- **Structure** — `page.accessibility.snapshot()` per page → `structure.json`.

Keep `capture.mjs` re-runnable — you reuse it in Phase 4.

## 2. Produce a COMPLETE task list

Read the recon folder and **investigate and produce a complete list of all the tasks that need to be
done** — design tokens, layout shell, one task per component (+ its states), per page, per feature,
motion pass, assets. Be exhaustive; a missed task is a missing piece. Write them to `PROGRESS.md`,
one line each, with a pointer to the recon artifact it needs. Gate any genuine design choice through
`preview-ui-first` first.

## 3. Spawn one agent per task

Via `parallel-subtasks`: land tokens + shell first, then **spawn one dedicated agent per task in a
single message**. Give each its `PROGRESS.md` line + the exact recon artifacts (screenshots + token
slice + feature spec) and the instruction to match the reference **pixel- and behavior-faithfully**.

## 4. Verify against the original

Re-run `capture.mjs` against the local clone and **diff screenshots side-by-side** with the Phase-1
captures (`toHaveScreenshot`/`pixelmatch`); spawn follow-up agents to close any gap. Then
`test-every-change` green (kill any port you opened), delete `draft/ref-<site>/` + `PROGRESS.md`, and
update `PROJECT.md` if the change is major. Never report done on a red suite or unverified clone.
