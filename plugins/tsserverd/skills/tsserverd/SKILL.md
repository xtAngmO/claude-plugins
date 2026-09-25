---
name: tsserverd
description: Check the shared TypeScript language server (tsserverd) — whether Claude Code sessions are sharing one tsserver per project, how much memory it and any unshared tsservers use, which TypeScript version each project is checked with, or why TypeScript diagnostics are missing. Use when the user asks about tsserverd, tsserver memory, or whether LSP sharing is working.
---

# tsserverd

tsserverd runs one typescript-language-server per TypeScript project. A project
is the nearest folder with its own `node_modules/typescript`. Every Claude Code
session that touches a project's files uses that project's one server. Inspect
it with the bundled CLI:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/tsserverd.mjs" status   # projects, sessions, memory, TS version
node "${CLAUDE_PLUGIN_ROOT}/bin/tsserverd.mjs" doctor   # which server would run
node "${CLAUDE_PLUGIN_ROOT}/bin/tsserverd.mjs" stop     # stop every daemon
```

Reading `status`:

- **One block per project.** "sessions N now" is how many Claude Code sessions
  currently share that server. "TypeScript x.y.z" is the project's own version.
- **No daemon running** is normal. A project's server starts the first time a
  session touches one of its files. A session lets go of a project after 15
  minutes without using it, and the daemon exits 5 minutes after its last
  session, so idle projects hold no memory.
- **`tsserver outside tsserverd`** counts tsservers this plugin does not own.
  They come from sessions started before tsserverd was enabled, or from
  sessions where the official `typescript-lsp` plugin is still on. Restarting
  those sessions frees that memory.
- Memory is the working set of each server and its tsserver at the moment
  `status` runs, not a peak.

If diagnostics are missing, run `doctor` first. `backend NOT FOUND` means
`typescript-language-server` is not installed:
`npm install -g typescript-language-server typescript@6`. Keep the `@6`:
TypeScript 7 has no `tsserver.js`, so `typescript-language-server` rejects it,
and the log then shows "Could not find a valid TypeScript installation". The
lifecycle log is at `<tmp>/tsserverd/tsserverd.log` (the folder is
`tsserverd-<uid>` on Linux and macOS).

Stop a daemon only when the user asks. Sessions reconnect to it on their next
edit.
