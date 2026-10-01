# PROJECT.md — claude-plugins

A Claude Code plugin marketplace (`xtangmo`). It is public on GitHub as `xtAngmO/claude-plugins`.

## Layout

```
.claude-plugin/marketplace.json   the catalog; each entry has "source": "./plugins/<name>"
plugins/typescript-lsp/            one tsserver per TypeScript project, shared by every session
                                   (named like the official plugin it replaces; the engine
                                   inside is "tsserverd": CLI, skill, log dir, TSD_* settings)
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
  test/                            node:test; `npm test` inside plugins/typescript-lsp
plugins/chrome-dev-tools-multitask/  chrome-devtools-mcp for many sessions (replaces chrome-devtools-mcp@claude-plugins-official)
  .mcp.json                        MCP server "chrome-devtools" = node bin/chrome-devtools-multitask.mjs
  bin/chrome-devtools-multitask.mjs  wiring only
  src/config.mjs                   CDP_* settings -> server args, cache scope, debug port flag (unit tested)
  src/proxy.mjs                    answers initialize/tools/list from cache, starts the real server on
                                   the first call, idle close (pure, unit tested against a fake server)
  src/live.mjs                     <CDP_HOME>/live/<pid>.json: which session owns which browser
  src/slots.mjs                    numbered persistent profiles, pid locks, sticky per project; throwaway profiles
  src/server.mjs                   runs chrome-devtools-mcp from npx's cache; kills a browser left on a profile
  src/cache.mjs, src/lines.mjs     the on-disk answer cache; JSON-lines framing
  data/answers-<spec>.json         bundled initialize/tools answers (scripts/snapshot.mjs), default flags only
  skills/                          chrome-devtools-mcp 1.10.1's skills, unchanged (Apache-2.0, see NOTICE)
  test/                            node:test; the integration suite needs chrome-devtools-mcp@1.10.1 in npx's cache
plugins/working-agreement/         skills only (no code, no tests): the user's global working agreement
  skills/<name>/SKILL.md           project-handoff-doc, parallel-subtasks, preview-ui-first, plan-docs,
                                   test-every-change, frontend-design, reference-design-feature
  skills/frontend-design/LICENSE.txt  that one skill is adapted from Anthropic's (Apache-2.0, see NOTICE)
```

The two layers: **router + link** make one session look like one LSP client per project.
**broker** makes one project's server look like it has one client. Each can be tested
alone with fakes (`test/router.test.mjs`, `test/broker.test.mjs`).

## Working on chrome-dev-tools-multitask

- **Slot lock files are shared** with the user's standalone `~/.claude/tools/cdp-slot-chrome.mjs`, which Codex still runs: same directory (`~/.cache/chrome-devtools-mcp/slots`), same `slot-N.lock` holding just a pid. Keep them compatible, or Codex and Claude Code will open two browsers on one profile. `slot-N.json` (project, last use) is ours alone; the old wrapper ignores it.
- **The answer cache** is keyed by chrome-devtools-mcp version + extra args + the client's protocol version. A new version or new flags means one eager start, then lazy again.
- **The plugin's own flags stay out of that key.** `config.mjs` keeps the user's flags in `extra` (the key, and any at all skips the bundled snapshot) and adds the plugin's own (`--logFile`, `--no-usage-statistics`, the debug port) only to `serverArgs`. A new plugin flag put in `extra` would make every machine start a server at `tools/list` time. `test/config.test.mjs` pins the default scope to the 1.3.0 value.
- **The debug port needs the pipe asked for too.** Puppeteer adds `--remote-debugging-pipe` only when no `--remote-debugging-*` flag is given. With just `--chromeArg=--remote-debugging-port=0` it silently switches to a WebSocket. So the plugin passes both, and Chrome serves both at once (checked on Chrome 154). A user's own `--remote-debugging-port` replaces ours and is left alone.
- **`DevToolsActivePort` outlives Chrome, even a clean exit.** `claim()` deletes it with the stale singleton files, so a reader never finds the previous browser's port in a slot profile.
- **The live file (`live/<pid>.json`)** is written in `#launch` and removed in `#teardown`, so it exists exactly while the proxy has a server. The throwaway profile is our own `mkdtemp` folder instead of `--isolated`, because a reader needs `profileDir` to find the port. It is deleted after its browser closes. puipui's api-server reads these files for its live browser view.
- **Closing stdin is how to stop the real server:** it exits and closes its Chrome (verified on 1.9.0 and 1.10.1). The browser kill in `server.mjs` is only the backstop for a server that was killed first.
- **`--no-usage-statistics` is what removes the telemetry watchdog process.** Running the entry script from npx's cache removes the npx parent. One node per browsing session, instead of the official plugin's three per session.
- **Hidden/visible belongs to the proxy.** `splitHeadless` strips every `--headless` / `--no-headless` from the pass-through flags and only uses it as the starting mode. Left in, it would pin the mode, and `set_browser_visible(true)` would restart a browser that is still hidden.
- **Stops chain, and a start waits for all of them.** A stop's clean-up closes any browser on its profile and frees the slot. The slot lock holds our own pid, so a new claim can land on that same slot. A start that ran before an older clean-up finished would have its new browser killed and its slot freed under it. A second stop (the visibility switch, say) must therefore await the first.
- **The empty start tab is closed by reading `## Pages` text.** Chrome starts with `about:blank`, and in 1.10 every page tool needs a `pageId` except `new_page`, so a session's first call is often `new_page` (27 of 63 browser starts in one `mcp.log`). The proxy watches each browser's first `new_page`, `isolatedContext` included: such a page opens in its own window, and before 1.4.2 the empty tab was left alone in the first one. Its line ends in ` isolatedContext=<name>`, which `leftoverBlankTab` reads. Closing the default context's only page is safe: Chrome stays up and later default-context pages open a new window (checked visible on 1.10.1). If its answer lists exactly two pages, an unselected `about:blank` and the selected new one, it sends its own `close_page` (id `cdp-mt:close-blank`, answer dropped) before passing the answer on, minus that line. `structuredContent` is only there behind a flag, so the text is all there is. If a new version changes that text, `leftoverBlankTab` returns null and nothing is closed.
- **A cancelled request is never answered by the server.** If it stayed in `#pending`, the idle close would never fire. One still in the queue is dropped, not sent.
- **The leftover-browser kill runs a PowerShell process query (about 1 s).** So it only runs when `slots.busy(profile)` says a browser still holds the profile. On macOS and Linux that is `SingletonLock` naming a live pid; never delete a live one.
- **Updating chrome-devtools-mcp:**
  1. Bump `CDP_MCP_VERSION`'s default in `bin/`.
  2. Re-copy `skills/` from that version.
  3. Run `npx chrome-devtools-mcp@<v> --help` once, so the integration suite finds it in the cache.
  4. Record its answers with `node scripts/snapshot.mjs chrome-devtools-mcp@<v>`. That writes `data/answers-<spec>.json`, which lets a first session start no server.
  5. Add the protocol version Claude Code uses if it changed: it was `2025-11-25` on 2.1.283.

## Working on working-agreement

- **The plugin is the source of truth.** The skills came unchanged from `~/.claude/skills/`, and those copies were deleted once the plugin was installed. Edit them here, bump the version and push; the user's sessions get the change after `/plugin marketplace update xtangmo` and a restart.
- **Placeholders stay as they are.** `<PLAN_DIR>`, `<DRAFT_DIR>`, the brand tokens and the test commands are filled per project (its `CLAUDE.md`). The README lists them with their defaults.
- **Skills refer to each other by bare name** (`parallel-subtasks`, `test-every-change`, ...). Installed, they are `working-agreement:<name>`. Keep all seven together, or a reference points at nothing.
- **Check it** with `claude plugin validate plugins/working-agreement`.

## Working on tsserverd

- Run `npm test` in `plugins/typescript-lsp`. It covers:
  - unit tests of the broker, the router and project resolution;
  - backend resolution;
  - an integration suite with the real `typescript-language-server`. Its fixture projects link `node_modules/typescript` to the global one. The suite is skipped if that server is not installed.
- To measure memory against the official plugin on a real repo, run N LSP clients each way and sum the working set of their process trees. See the 1.1.0 commit for the numbers.
- To try a change in a real session without installing it:
  `claude --plugin-dir plugins/typescript-lsp --settings '{"enabledPlugins":{"typescript-lsp@claude-plugins-official":false}}'`
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
