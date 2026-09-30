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
   files — `<DRAFT_DIR>/<feature>-option-a.html`, `-option-b.html`, … — and present them: list the file
   paths to open **and** ask which to pick (an `AskUserQuestion`). Build the options **in parallel** via
   the `parallel-subtasks` skill (one agent per option).

3. **Wait for the pick.** Do **not** implement the real component until the user chooses (they may also
   request tweaks to a mockup first).

4. **Implement, then clean up.** Build the chosen design in the project's framework, then **delete that
   feature's `<DRAFT_DIR>/*.html` files** — they're throwaway.

## Folder

`<DRAFT_DIR>/` holds **transient** UI mockups — gitignore the `*.html`, and delete a feature's drafts
once its design is picked and implemented. Copy the preview base from `<PLAN_DIR>/_TEMPLATE.html` so
mockups stay consistent — **if that template doesn't exist yet, create it first** (see the `plan-docs`
skill; it's the shared brand-styled base for both mockups and plans).

> Kept planning/spec docs are a **separate** concern — they live in `<PLAN_DIR>/` as styled HTML and are
> not throwaway. See the `plan-docs` skill.
