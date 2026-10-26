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
  src/memory.mjs                   memory pressure (os.freemem vs TSD_PRESSURE_FREE_MB) and the heap cap:
                                   default 6656 MB, doubled per project after a tsserver death (<key>.cap.json)
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
plugins/answer-for-me/             one skill + a read-only CLI: a session that stands in for the user
  skills/answer-for-me/SKILL.md    the run: scope, find, answer, land approved work, wait, report
                                   (`disable-model-invocation: true`: only the user's /answer-for-me starts it)
  bin/peek.mjs                     prints this project's live sessions and what each is waiting on
  hooks/hooks.json                 PermissionRequest on AskUserQuestion -> bin/ask-guard.mjs (every session)
  bin/ask-guard.mjs                offers the open dialog to the stand-in, waits alongside it, returns its answer
  bin/standin.mjs                  the stand-in's side: on/off/watch/show/answer/pass/status
  src/sessions.mjs                 reads ~/.claude/sessions/*.json + transcripts (pure parts unit tested)
  src/standin.mjs                  ~/.claude/answer-for-me/{active,asks}: markers, asks, answers, outcomes;
                                   routes each ask to a stand-in when it is read
  src/dialog.mjs                   has the user already answered this dialog? reads the transcript incrementally
  scripts/e2e.mjs                  the dialog hook against a real claude, as the desktop app runs it (calls the API)
  test/                            node:test; `npm test` inside plugins/answer-for-me
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
- **`parallel-subtasks` is gated by cost (1.2.0).** Main thread by default; fan out only for 3+ independent, large subtasks (or when the user asks), max 3 agents, no nesting. Before 1.2.0 it fanned out on "any non-trivial task", and one user's week measured subagents at 60% of usage. `preview-ui-first` writes its mockups without agents; `reference-design-feature` keeps its per-task fan-out. 1.2.1 adds, from Anthropic's "fold subagents into your main agent loop" (2026-10-22) and Vals AI's agent-team study: split by context not by role, one black-box verifier allowed when test output is long, workflows small.

## Working on answer-for-me

- **It only reads Claude Code's own files.** `~/.claude/sessions/<pid>.json` (name, sessionId, cwd, status) is
  what `ListAgents` shows; the transcript is `~/.claude/projects/<slug>/<sessionId>.jsonl`. `CLAUDE_CONFIG_DIR`
  moves both. A session file outlives a crashed process, so `pidAlive` checks the pid. Node's
  `process.kill(pid, 0)` only checks on Windows too; Python's `os.kill(pid, 0)` would terminate the process.
- **Scope is the point.** The first real run answered sessions of five unrelated repos and the user pushed back.
  `selectSessions` keeps only sessions whose cwd is inside `--project` (default: the current directory) and counts
  the rest; `--all` is for when the user names other projects.
- **Dialogs are answered by a PermissionRequest hook that races the dialog, not by a message.** A session on an
  `AskUserQuestion` dialog doesn't read messages until the dialog closes. Claude Code 2.1.296 runs PermissionRequest
  hooks alongside the open dialog, and whichever answers first wins. In the bundle:
  - SDK / stream-json path (the desktop app): `Promise.race([hook, can_use_tool request])`. When the hook wins,
    `b.abort()` sends the host a `control_cancel_request` and the dialog closes.
  - Terminal UI: the hooks run in the background through `runHooks`, and the first decision `claim()`s the dialog.

  `ask-guard.mjs` prints `hookSpecificOutput` with `hookEventName: "PermissionRequest"` and
  `decision: {behavior: "allow", updatedInput: {questions, answers, annotations}}`, and the tool resolves with those
  answers. `answers` is keyed by question text, the value is the option label (multi-select: labels joined by
  ", "). 1.1.0 used PreToolUse, which runs once, before the dialog opens: a stand-in that came on later could not
  answer a dialog already on screen, and the user had to press Esc. Since 1.2.0 the dialog is always shown,
  stand-in or not.
- **The tool result carries the annotation notes** (`The user answered: "Q"="A" notes: Answered by <stand-in>,
  the user's stand-in session (/answer-for-me), not typed by the user.`). That is how the asking model learns who
  answered. PermissionRequest output has no `additionalContext`, and none is needed. Checked on 2.1.296.
- **The hook is not stopped when the user answers in the dialog.** It is tied to the turn's abort signal, not to
  the dialog: in one run it kept going ~13 s after the host answered, until claude exited. So `src/dialog.mjs`
  (`DialogWatch`) reads `transcript_path` incrementally. The dialog's tool_use is the latest AskUserQuestion with
  the same question texts; once a tool_result for that id is appended, the dialog is closed. The hook starts
  before the dialog is shown, so tool_results already in the transcript at start belong to earlier dialogs and are
  ignored. The hook input has no tool_use_id. Fields seen: session_id, transcript_path, cwd, prompt_id,
  permission_mode, effort, hook_event_name, tool_name, tool_input, plus agent_id inside a subagent.
- **Subagents and teammates wait for the hook *before* the dialog** (`awaitAutomatedChecksBeforeDialog`). So when
  the input has `agent_id`, the hook keeps 1.1.0's rule: it waits only when a stand-in is already on, and at most
  10 minutes, because the dialog is not shown meanwhile. A subagent's tool calls are in its own transcript, so
  there is no `DialogWatch` there.
- **Asks are routed when read, not when written.** The hook writes `asks/<id>.json` (hookPid, sessionPid, cwd,
  questions) for every dialog, stand-in or not. `pickStandIn` gives an ask to the most specific live stand-in
  whose project contains its cwd, never to the asking session itself, so a stand-in that comes on later sees
  dialogs that were already open. `pendingAsks` drops (and, unless `sweep: false`, deletes) asks whose hookPid is
  dead, 1.1.0 asks (no hookPid) older than 11 minutes, and `.done.json` files older than an hour. `peek.mjs`
  reads with `sweep: false`, so it still writes nothing.
- **Every ask ends in an outcome file.** On exit the hook writes `asks/<id>.done.json` (`delivered`, `passed`,
  `answered-in-dialog`, `session-gone`, `withdrawn`, `timeout`) and removes the ask and its answer file.
  `standin.mjs answer` and `pass` wait up to ~8 s for it and print what happened.
- **How it was verified:** end to end with the real claude.exe 2.1.296 in the desktop app's mode
  (`--input-format stream-json --permission-prompt-tool=stdio`) under a fake host, both ways: hook answers first
  (the host gets `control_cancel_request`, the tool resolves with the hook's answers) and host answers first (the
  hook keeps running; `DialogWatch` is what ends it). The terminal UI path was checked only by reading the bundle.
  `scripts/e2e.mjs` repeats both cases with the plugin itself (`--plugin-dir`): a dialog open 6 s with no stand-in,
  then `on` + `watch` + `answer` prints `delivered`; and the user answering first, after which the hook leaves
  (`answered-in-dialog`) within a second while claude keeps running. Run it after every Claude Code update:
  `STANDIN_NAME=<a live session's name> node scripts/e2e.mjs` (haiku, two short turns).
- **Sessions started before 1.2.0 keep the 1.1.0 PreToolUse hook** until they restart, so a dialog they open
  while no stand-in is on stays the user's. A 1.1.0 hook's ask is still answered by a 1.2.0 stand-in that was
  already on: same asks directory, same answer file.
- **The hook must never break a session:** every path exits 0, and no output means the user's dialog decides. In
  a subagent, without a live stand-in marker (pid alive) for the session's cwd, it returns before touching
  anything.
- **Peers refuse relayed approval for push/migrate,** and that is correct. The skill tells the stand-in to land
  that work itself, by exact SHA, when the user approved it in the stand-in session.
- **Check it** with `npm test` and `claude plugin validate plugins/answer-for-me`.

## Working on security-audit

- **One skill, written from a real incident.** A sibling app (jcr-web, 2026-10-06..08) was taken over through four
  weaknesses that chained together:
  1. admin endpoints had no permission check;
  2. the server-side sanitizer was regex-based;
  3. an admin was lured to the page through support chat;
  4. create-user/change-role never checked that the actor outranks the target role.

  The audit of whmcs-web that followed is the worked example behind every reference file. Keep new patterns
  concrete: what to grep, how to confirm, the fix.
- **Read-only against production is the contract.** The only production touches the skill allows:
  - one plain `GET` for headers;
  - read-only DB queries that print counts, never values.

  Don't add steps that send payloads or forge cookies against live systems.
- **The scanner (`scripts/scan-serverfns.mjs`) has no dependencies and runs on node 18+ or bun.**
  - It is a hand-written bracket matcher that understands strings, template literals, comments and regex literals.
    A regex literal containing quotes (`/^["'`]+/`) used to swallow the next server function. The test pins that.
  - It follows same-file `const alias = middleware` so `adminOnly = authMiddleware` reads as auth-only.
  - Alias expressions may span lines, and a call to a local guard factory (`readGuard(P.calls)` where
    `const readGuard = (p) =>\n requireAnyPermission(…)`) is resolved through the factory's body. Before that,
    the fixed whmcs-web reported 18 permission-guarded recording fns as `none`. The test pins both cases.
  - Imported aliases are classified by name only.
  - Checked against whmcs-web: HEAD before the fix 395 fns (126 permission / 259 auth-only / 10 none), identical
    to an AST scan; after the fix 396 fns (375 / 11 / 10). The 10 `none` are login/locale cookies; the 11 are
    self-service.
- **Check it** with `npm test` inside `plugins/security-audit` and `claude plugin validate plugins/security-audit`.

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
- **A 12 GB heap cap is mostly garbage.** V8 grows the old generation toward its limit before collecting. With 12288 MB one tsserver read 6.7 GB and, a minute later in the same process, 2.9 GB. The biggest repo measured (fastagent-web-client, 6,227 files) keeps 4.15–4.3 GB live during a full check, and peaked at 8.0 GB of private memory under 12288 versus 5.4 GB under 6656, with the same check time and 12–60 ms full-GC pauses. To measure a repo's live heap, run its own `tsserver.js` with `--trace-gc --max-old-space-size=12288`, `open` one file per tsconfig, `geterrForProject`, and read the largest "after" value of the Mark-Compact lines (2026-10-15, 14 repos).
- **Release, don't kill.** A session's link counts every lost connection, and three in two minutes make it give up on that project for five minutes. That is why memory pressure shortens the idle waits (graceful `release()` and an empty daemon exiting) instead of stopping busy daemons.
- **Diagnostics timing:** Claude Code hands diagnostics to the model on the *next* tool call after an edit. A session that ends its turn right after editing never shows them. That is Claude Code's behaviour, not a delivery bug.
