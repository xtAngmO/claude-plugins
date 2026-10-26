# working-agreement

A working agreement for Claude Code, packaged as seven skills. Each one triggers on its own from its description, and they hand off to each other: orient from `PROJECT.md`, fan large independent work out to parallel agents only when it pays, mock UI before building it, and don't call anything done until the tests are green.

## Skills

| Skill | Use it when | In one line |
| --- | --- | --- |
| `project-handoff-doc` | starting unfamiliar work · after a major change | Read **`PROJECT.md` first** instead of scanning the tree; create it if missing; update it after any **major** change (not hotfixes). |
| `parallel-subtasks` | the user asks for parallel work, **or** 3+ truly independent subtasks that are each large | Default is **do it in the main thread** — a subagent starts cold and re-sends its whole context every turn. Past the bar: **spawn the agents in a single message** (max 3) and track them in `PROGRESS.md`. |
| `preview-ui-first` | any **UI** change or new screen | Mock it in self-contained HTML under `draft/` first, offer **2–3 options** as clickable links, and **wait for the pick** before implementing. |
| `plan-docs` | writing a plan, spec, requirement or design doc | Write it as **styled HTML in `plan/`**, never markdown. Plans are kept; drafts are thrown away. |
| `test-every-change` | finishing **any** code change | Run **unit + integration** green; add **E2E** when the project has both a backend and a frontend. Don't report done on red. |
| `frontend-design` | building or styling any UI | Commit to a distinctive, production-grade aesthetic instead of the generic AI look. |
| `reference-design-feature` | the user gives a **reference site URL** to copy | Capture the live site with **Playwright** (tokens, screens, motion, features), write a complete task list, **fan out one agent per task**, then diff screenshots against the original. Design-only or design + features. |

## How they chain

1. **Orient.** Read `PROJECT.md` (`project-handoff-doc`) before scanning the tree. If the task needs a written plan or spec, write it as styled HTML in `plan/` (`plan-docs`).
2. **If it is UI,** run `preview-ui-first`. Write the 2–3 mockups yourself (small HTML files, no agents), then wait for the user's pick.
3. **Implement** in the main thread. Fan out (`parallel-subtasks`) only when the work clears its bar; then each agent owns one `PROGRESS.md` line.
4. **Land it.** If you fanned out, combine the agents' results; then run the full suite green over the combined change (`test-every-change`). If the change is major, update `PROJECT.md`. Then the main agent deletes `PROGRESS.md` (if one was made) and the `draft/*.html` mockups.

## Per-project settings

Some skills leave project-specific values as placeholders. Set them in the project's `CLAUDE.md`. Without a value, Claude uses the default below, or works the value out from the project itself.

| Placeholder | Used by | Default |
| --- | --- | --- |
| `<PLAN_DIR>` | `plan-docs`, `preview-ui-first` | `plan/` |
| `<DRAFT_DIR>` | `preview-ui-first`, `plan-docs` | `draft/` |
| `<BRAND_NAME>`, `<DISPLAY_FONT>`, `<COLOR_PRIMARY>`, `<COLOR_ACCENT>` | `plan-docs`, `preview-ui-first` | — |
| `<UNIT_TEST_CMD>`, `<INTEGRATION_TEST_CMD>`, `<E2E_TEST_CMD>` | `test-every-change` | — |

## Install

```
/plugin marketplace add xtAngmO/claude-plugins
/plugin install working-agreement@xtangmo
```

The skills show up as `working-agreement:<skill>`. If you already keep copies of the same skills in `~/.claude/skills/`, remove those after installing, or Claude sees each skill twice. The same goes for the official `frontend-design` plugin, which covers the same ground as this plugin's `frontend-design` skill.

## Credits and licences

- The plugin is MIT; see `LICENSE`.
- `skills/frontend-design` is adapted from the `frontend-design` skill in Anthropic's [claude-plugins-official](https://github.com/anthropics/claude-plugins-official), licensed Apache-2.0; see `skills/frontend-design/LICENSE.txt` and `NOTICE`.
