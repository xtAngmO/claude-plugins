# claude-plugins

Claude Code plugins by [xtAngmO](https://github.com/xtAngmO).

```
/plugin marketplace add xtAngmO/claude-plugins
```

| Plugin | What it does |
| --- | --- |
| [typescript-lsp](plugins/typescript-lsp) | TypeScript/JavaScript LSP that runs one tsserver per project and shares it with every Claude Code session, instead of a 2–4 GB tsserver per session. Works on Windows. |
| [chrome-dev-tools-multitask](plugins/chrome-dev-tools-multitask) | chrome-devtools-mcp for many sessions at once: each browsing session gets its own hidden Chrome on its own persistent profile (sticky per project, shown in a window on request); sessions that never browse run no browser server; unused browsers close after 30 minutes. |
| [working-agreement](plugins/working-agreement) | A working agreement as seven skills that chain together: read `PROJECT.md` first, fan work out to parallel agents, mock UI as HTML options before building it, write plans as styled HTML, clone a reference site with Playwright, and run the tests green after every change. |

Install a plugin with `/plugin install <name>@xtangmo`.
