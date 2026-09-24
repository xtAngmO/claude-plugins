---
name: tsserverd
description: Check the shared TypeScript language server (tsserverd) — whether Claude Code sessions are sharing one tsserver, how much memory it and any unshared tsservers use, or why TypeScript diagnostics are missing. Use when the user asks about tsserverd, tsserver memory, or whether LSP sharing is working.
---

# tsserverd

tsserverd runs one typescript-language-server per project root and lets every
Claude Code session in that root use it. Inspect it with the bundled CLI:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/tsserverd.mjs" status   # daemons, sessions, memory
node "${CLAUDE_PLUGIN_ROOT}/bin/tsserverd.mjs" doctor   # which server would run
node "${CLAUDE_PLUGIN_ROOT}/bin/tsserverd.mjs" stop     # stop every daemon
```

Reading `status`:

- **No daemon running** is normal. Daemons start the first time a session
  opens a TS/JS file and exit 10 minutes after the last session leaves.
- **`tsserver outside tsserverd`** counts tsservers this plugin does not own.
  They come from sessions started before tsserverd was enabled, or from
  sessions where the official `typescript-lsp` plugin is still on. Closing
  those sessions frees that memory.
- Memory is the working set of the shared backend and its tsservers at the
  moment `status` runs, not a peak.

If diagnostics are missing, run `doctor` first. `backend NOT FOUND` means
`typescript-language-server` is not installed:
`npm install -g typescript-language-server typescript@6`. Keep the `@6`:
TypeScript 7 has no `tsserver.js`, so `typescript-language-server` rejects it,
and the log then shows "Could not find a valid TypeScript installation". The
lifecycle log is at `<tmp>/tsserverd/tsserverd.log` (the folder is
`tsserverd-<uid>` on Linux and macOS).

Stop a daemon only when the user asks. Every session attached to it loses LSP
until it reconnects.
