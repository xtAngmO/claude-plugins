---
name: preview-ui-first
description: Preview any UI change as a self-contained HTML mockup BEFORE writing framework code. Use before building or editing any user-facing screen, page, component, or visual — offer 2–3 distinct options and wait for the user to pick.
---

# Preview UI before implementing

Follow this **before** writing any component/page code for a user-facing change. Mockups come first; the
aesthetic detail is applied inside them (see the `frontend-design` skill).

## For ANY UI change or new screen/component

1. **Mock it in HTML first.** Build a **self-contained** HTML mockup with **realistic mock data** in
   `<DRAFT_DIR>/` — inline CSS, no build step, opens straight in a browser. Match the product brand so it
   looks real (`<BRAND_NAME>`: font `<DISPLAY_FONT>`; primary `<COLOR_PRIMARY>`, accent `<COLOR_ACCENT>`).
   Keep a `<PLAN_DIR>/_TEMPLATE.html` and copy it so previews stay consistent.

2. **Offer choices.** When there's a real design decision, produce **2–3 distinct options** as separate
   files — `<DRAFT_DIR>/<feature>-option-a.html`, `-option-b.html`, … — and present them: end the
   message with a **clickable link to every mockup** (see *Link every mockup* below) **and** ask which
   to pick (an `AskUserQuestion`). Build the options **in parallel** via the `parallel-subtasks` skill
   (one agent per option).

3. **Wait for the pick.** Do **not** implement the real component until the user chooses (they may also
   request tweaks to a mockup first). After a tweak, link the updated file again.

4. **Implement, then clean up.** Build the chosen design in the project's framework, then **delete that
   feature's `<DRAFT_DIR>/*.html` files** — they're throwaway.

## Link every mockup

Whenever a reply creates or changes a mockup, **finish that reply with a markdown link to each file**,
so the user can open it with one click in the Claude Code VS Code extension:

```markdown
**Mockups — click to open:**
- **A — Compact cards** · [checkout-option-a.html](draft/checkout-option-a.html)
- **B — Split summary** · [checkout-option-b.html](draft/checkout-option-b.html)
```

- **Link format:** `[name](path)` with the path **relative to the workspace root** (the folder open in
  VS Code), forward slashes, no leading `./`. If the session's working directory is not the workspace
  root, write the path from the workspace root anyway.
- **No backticks around the link.** A path in backticks, or a bare path, isn't clickable.
- **Spaces in the path:** wrap the target in angle brackets — `[name](<draft/my mockup.html>)`.
- **Put the links in the message text, last,** right before the `AskUserQuestion` — not only inside
  the dialog's options. One mockup still gets its link.
- **The same goes for subagents' work.** When agents build the options, the main agent writes the links
  after collecting their results.

## Folder

`<DRAFT_DIR>/` holds **transient** UI mockups — gitignore the `*.html`, and delete a feature's drafts
once its design is picked and implemented. Copy the preview base from `<PLAN_DIR>/_TEMPLATE.html` so
mockups stay consistent — **if that template doesn't exist yet, create it first** (see the `plan-docs`
skill; it's the shared brand-styled base for both mockups and plans).

> Kept planning/spec docs are a **separate** concern — they live in `<PLAN_DIR>/` as styled HTML and are
> not throwaway. See the `plan-docs` skill.
