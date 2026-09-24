# PROJECT.md — claude-plugins

A Claude Code plugin marketplace (`xtangmo`). It is public on GitHub as `xtAngmO/claude-plugins`.

## Layout

```
.claude-plugin/marketplace.json   the catalog; each entry has "source": "./plugins/<name>"
plugins/tsserverd/                 one tsserver per project root, shared by every session
  .claude-plugin/plugin.json       the plugin manifest
  .lsp.json                        Claude Code starts `node src/shim.mjs --stdio` for TS/JS files
  src/shim.mjs                     the per-session stdio bridge; falls back to the real server
  src/daemon.mjs                   one per root; owns the named pipe or socket and the backend
  src/broker.mjs                   the multiplexing rules (pure logic, unit tested)
  src/backend.mjs                  finds typescript-language-server's cli.mjs
  src/lib.mjs                      LSP framing, root keys, endpoint names
  bin/tsserverd.mjs                the status / doctor / stop CLI
  skills/tsserverd/SKILL.md        lets Claude run the CLI when asked
  test/                            node:test; `npm test` inside plugins/tsserverd
```

## Working on tsserverd

- Run `npm test` in `plugins/tsserverd`. It covers broker unit tests, backend resolution, and an integration test with the real `typescript-language-server`. The integration test is skipped if that server is not installed.
- To try a change in a real session without installing it:
  `claude --plugin-dir plugins/tsserverd --settings '{"enabledPlugins":{"typescript-lsp@claude-plugins-official":false}}'`
- Set `TSD_NAMESPACE=<anything>` to keep an experiment away from the daemons your real sessions use.
- The lifecycle log is at `<os tmpdir>/tsserverd/tsserverd.log`.

## Releasing

1. Bump `version` in **both** `plugins/<name>/.claude-plugin/plugin.json` and its entry in `.claude-plugin/marketplace.json`. Claude Code caches plugins by version, so users do not get an unbumped change.
2. Commit in English and push to `main`.
3. Users run `/plugin marketplace update xtangmo`. Sessions pick up the new version when they restart.

## Things that bit us

- **Windows:** Node cannot listen on a file path, so the endpoint must be a named pipe.
- **Windows:** npm's extensionless launcher is a sh script, and `.cmd` needs `shell: true`. tsserverd runs `lib/cli.mjs` with `process.execPath` instead.
- **Windows:** typescript-language-server respells `file:///D:/x` as `file:///d%3A/x` in diagnostics. Compare documents by `docKey()`, never by uri string.
- **Diagnostics timing:** Claude Code hands diagnostics to the model on the *next* tool call after an edit. A session that ends its turn right after editing never shows them. That is Claude Code's behaviour, not a delivery bug.
