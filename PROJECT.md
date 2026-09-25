# PROJECT.md — claude-plugins

A Claude Code plugin marketplace (`xtangmo`). It is public on GitHub as `xtAngmO/claude-plugins`.

## Layout

```
.claude-plugin/marketplace.json   the catalog; each entry has "source": "./plugins/<name>"
plugins/tsserverd/                 one tsserver per TypeScript project, shared by every session
  .claude-plugin/plugin.json       the plugin manifest
  .lsp.json                        Claude Code starts `node src/shim.mjs --stdio` for TS/JS files
  src/shim.mjs                     per session: wiring only (TSD_DISABLE = plain passthrough)
  src/router.mjs                   per session: routes each file to its project's link (pure, unit tested)
  src/link.mjs                     session ↔ one project: daemon socket or private server,
                                   reconnect + re-open, idle release, failure pause
  src/project.mjs                  which project a file belongs to (nearest node_modules/typescript)
  src/capabilities.mjs             answers initialize; learned once from a probe, cached on disk
  src/daemon.mjs                   one per project; owns the named pipe or socket and the backend
  src/broker.mjs                   the multi-session rules inside a daemon (pure, unit tested)
  src/backend.mjs                  finds typescript-language-server's cli.mjs
  src/lib.mjs                      LSP framing, root keys, endpoint names
  bin/tsserverd.mjs                the status / doctor / stop CLI
  skills/tsserverd/SKILL.md        lets Claude run the CLI when asked
  test/                            node:test; `npm test` inside plugins/tsserverd
```

The two layers: **router + link** make one session look like one LSP client per project.
**broker** makes one project's server look like it has one client. Each can be tested
alone with fakes (`test/router.test.mjs`, `test/broker.test.mjs`).

## Working on tsserverd

- Run `npm test` in `plugins/tsserverd`. It covers:
  - unit tests of the broker, the router and project resolution;
  - backend resolution;
  - an integration suite with the real `typescript-language-server`. Its fixture projects link `node_modules/typescript` to the global one. The suite is skipped if that server is not installed.
- To measure memory against the official plugin on a real repo, run N LSP clients each way and sum the working set of their process trees. See the 1.1.0 commit for the numbers.
- To try a change in a real session without installing it:
  `claude --plugin-dir plugins/tsserverd --settings '{"enabledPlugins":{"typescript-lsp@claude-plugins-official":false}}'`
- Set `TSD_NAMESPACE=<anything>` to keep an experiment away from the daemons your real sessions use.
- The lifecycle log is at `<os tmpdir>/tsserverd/tsserverd.log`. The folder is `tsserverd-<uid>` on Linux and macOS.
- To exercise the unix socket path from Windows, use WSL with a throwaway node:
  1. Unpack a node tarball under `/tmp`.
  2. Run `npm i -g --prefix /tmp/x typescript-language-server typescript@6`.
  3. Copy the plugin into `/tmp` and run `node --test "test/*.test.mjs"` with `PATH` set to only those bin dirs plus `/usr/bin:/bin`.

  If you leave the default PATH, WSL finds the Windows launchers through interop.

## Releasing

1. Bump `version` in **both** `plugins/<name>/.claude-plugin/plugin.json` and its entry in `.claude-plugin/marketplace.json`. Claude Code caches plugins by version, so users do not get an unbumped change.
2. Commit in English and push to `main`.
3. Users run `/plugin marketplace update xtangmo`. Sessions pick up the new version when they restart.

## Things that bit us

- **Windows:** Node cannot listen on a file path, so the endpoint must be a named pipe.
- **Windows:** npm's extensionless launcher is a sh script, and `.cmd` needs `shell: true`. tsserverd runs `lib/cli.mjs` with `process.execPath` instead.
- **Windows:** typescript-language-server respells `file:///D:/x` as `file:///d%3A/x` in diagnostics. Compare documents by `docKey()`, never by uri string.
- **TypeScript 7:** `npm i -g typescript` now installs TS 7, which has no `tsserver.js`. typescript-language-server then fails `initialize`. Install `typescript@6` globally. Supporting TS 7 would mean a second backend (`tsc --lsp --stdio`), which does not exist yet.
- **Unix sockets:** the socket file outlives a crashed daemon. The takeover is serialized by `<endpoint>.lock`, and the endpoint only counts as dead on `ECONNREFUSED`. The daemon listens on a private name and renames it into place, because libuv unlinks the listened-on path when the server closes.
- **Claude Code's LSP root is its current working directory, which follows `cd`.** That is why 1.0.x, which keyed by session root, rarely shared: one real session ended up rooted in `node_modules/better-auth`. 1.1.0 ignores the session root and routes by file.
- **typescript-language-server picks TypeScript from the root's `node_modules`, and falls back to the global install.** A session rooted above several repos was therefore checked with the global TS. The router pins each project's own TS with `initializationOptions.tsserver.path`.
- **Diagnostics timing:** Claude Code hands diagnostics to the model on the *next* tool call after an edit. A session that ends its turn right after editing never shows them. That is Claude Code's behaviour, not a delivery bug.
