---
name: plan-docs
description: Write any forward-looking plan, spec, requirement, or design doc as a styled HTML file in plan/, never as markdown. Use whenever you produce a planning/spec/requirement/design document — these are kept artifacts (unlike throwaway UI drafts).
---

# Plans & specs are styled HTML, not markdown

Any **forward-looking** document — a requirement, plan, spec, design doc, or proposal — goes in
`<PLAN_DIR>/` as a **styled HTML file** (brand styling), **never** a `.md`.

## Rules

1. **Location & format.** Write it to `<PLAN_DIR>/<name>.html` as self-contained, brand-styled HTML that
   opens straight in a browser — not markdown, not a loose `.md` in the repo root.
2. **Start from the template — create it if missing.** Copy `<PLAN_DIR>/_TEMPLATE.html` so every
   plan/spec shares the same on-brand look (`<BRAND_NAME>`: font `<DISPLAY_FONT>`; primary
   `<COLOR_PRIMARY>`, accent `<COLOR_ACCENT>`). **If `<PLAN_DIR>/_TEMPLATE.html` doesn't exist yet, create
   it first** — a self-contained, brand-styled HTML base with the fonts/colors wired in, a brand header,
   and an empty content scaffold — then copy it. This is the same base the UI mockups use
   (`preview-ui-first`), so plans and previews feel like one product; whoever creates it first makes it
   available to both.
3. **These are kept, not throwaway.** Unlike the `<DRAFT_DIR>/*.html` mockups (deleted after a design is
   picked), plan/spec docs in `<PLAN_DIR>/` are durable references — keep them current rather than
   deleting them.

## Folder

`<PLAN_DIR>/` — kept planning/spec/design docs (styled HTML) + the shared preview `_TEMPLATE.html`.

> Transient UI mockups are a **separate** concern — they live in `<DRAFT_DIR>/` and are deleted after the
> pick. See the `preview-ui-first` skill.
