# chrome-dev-tools-multitask

A multi-session replacement for the official `chrome-devtools-mcp` plugin for Claude Code. Every session that opens a browser gets **its own Chrome on its own persistent profile**, in **a normal window you can watch**, hidden (headless) only when you ask for it. Sessions that never browse run **no browser server at all**. A browser nobody is using is closed after 30 minutes.

It uses the same `chrome-devtools-mcp` (1.10.1), exposes the same 30 tools plus one of its own (`set_browser_visible`), and bundles the same skills.

## Why

- **Two sessions fight over one browser.** The official plugin gives every session the same profile (`~/.cache/chrome-devtools-mcp/chrome-profile`), and Chrome lets only one browser use a profile at a time. The second session to open a browser gets an empty `DevToolsActivePort` and its tool calls fail at random.
  - `--isolated` avoids the fight, but gives every launch a throwaway profile, so nothing stays signed in.
  - One shared browser (`--browserUrl`) mixes the sessions up: shared tabs, `list_pages` indices that shift, and one session's `new_page` stealing the other's selected page.
- **Every session pays for a browser it never opens.** Claude Code starts every MCP server with every session. On one machine, 26 sessions each kept `chrome-devtools-mcp` running: three node processes per session and about 260 MB of private memory, even though 18 of them had never opened a browser. Browsers left open in idle sessions held up to 3.3 GB more.

## How it works

- **Slots.** A browser claims one of 8 numbered profiles, guarded by a lock that holds its process id:
  - slot 1 is the profile chrome-devtools-mcp always used, so existing sign-ins keep working;
  - slots 2–8 are `~/.cache/chrome-devtools-mcp/profile-N`;
  - with all 8 taken, a browser gets a throwaway profile rather than colliding with one.

  A lock left by a process that died is taken over, by one session only when two find it at once. A profile some other browser still holds is skipped (on Windows its `lockfile` is open; on macOS and Linux its `SingletonLock` names a live process).
- **Sticky per project.** A slot remembers which project (git repository) last used it. A project gets its own profile back when that slot is free. A new project takes an unclaimed slot before it borrows another project's.
- **Lazy.** The plugin answers `initialize` and `tools/list` from a snapshot of what the real server says. The snapshot ships with the plugin (`data/`), and is learned on first use when you add extra flags. So even a machine's very first session starts nothing and downloads nothing: Claude Code gives an MCP server only 30 seconds to connect. It starts `chrome-devtools-mcp`, and claims a slot, only when a tool is actually called. The server runs straight from npx's cache: one node process, and no telemetry watchdog.
- **A window by default.** Browsers open in a normal Chrome window, like the official plugin, so you can watch what happens, sign in with 2FA, or solve a captcha yourself. For long unattended work, ask Claude to hide the browser: the `set_browser_visible` tool restarts it headless on the same profile, with a 1280×800 viewport (headless Chrome defaults to 800×600, which responsive pages lay out as a tablet). Sign-ins are kept but open pages are closed. Ask again to show it. Set `CDP_HEADLESS=1` to start hidden instead.
- **Idle close.** After 30 minutes without a tool call, the server is stopped. That closes its Chrome and frees the slot. The next call starts it again on the same project's profile, so sign-ins survive, but open tabs do not.
- **Failures.** If the server or its browser dies, the calls it owed are answered with an error and the next call starts a fresh one. A server that has not answered within 2 minutes of starting (a stalled download, say) is given up on the same way. A browser still left on a profile is closed before the slot is given back.
- **Cancelled calls.** A call Claude cancels before the browser is up is never sent, so a cancelled click never happens. One already running is passed on, and no longer keeps the browser from its idle close.
- **Watchable from outside.** Every browser also listens on a local debug port, and a small file says which session owns it, so another program on the same machine can show you the page live and let you click into it. See [Live view](#live-view-debug-port-and-discovery-file).

The slot lock files are the ones the standalone `cdp-slot-chrome.mjs` wrapper uses, so Codex running that wrapper and Claude Code running this plugin never claim the same profile.

## Install

```
/plugin marketplace add xtAngmO/claude-plugins
/plugin install chrome-dev-tools-multitask@xtangmo
/plugin disable chrome-devtools-mcp@claude-plugins-official
```

Disable the official plugin. Otherwise every session runs both servers and sees both sets of tools. Sessions that are already running keep the old one until they restart.

You need Node 20.19 or newer, and Chrome. The first browser call on a machine has `npx` download `chrome-devtools-mcp` first, so it takes longer. Session startup never waits for that.

## Settings

Set these in the environment Claude Code runs in.

| Variable | Default | What it does |
| --- | --- | --- |
| `CDP_IDLE_MINUTES` | `30` | Close a browser nobody has used for this long. `0` = never. |
| `CDP_MAX_SLOTS` | `8` | Persistent profiles. Beyond this many browsers at once, a throwaway profile. |
| `CDP_MCP_VERSION` | `chrome-devtools-mcp@1.10.1` | The chrome-devtools-mcp to run. |
| `CDP_EXTRA_ARGS` | — | More chrome-devtools-mcp flags, e.g. `--slim` or `--viewport=1920x1080`. |
| `CDP_HEADLESS` | off | `1` = start browsers hidden (headless), with a 1280×800 viewport. A session can still switch with `set_browser_visible`. A `--headless` or `--no-headless` in `CDP_EXTRA_ARGS` does the same: it sets how browsers start, and the tool can still switch them. |
| `CDP_LAZY` | on | `0` = start the server with the session, like the official plugin. |
| `CDP_HOME` | `~/.cache/chrome-devtools-mcp` | Where profiles, slots, the cache and the `live/` files live. |
| `CDP_DEBUG_PORT` | on | `0` = no local debug port on the browsers (see [Live view](#live-view-debug-port-and-discovery-file)). The `live/` file is still written. A `--remote-debugging-port` of your own in `CDP_EXTRA_ARGS` replaces the plugin's. |

Diagnostics go to the MCP server's stderr, which is in Claude Code's MCP log. Lines start with `[chrome-devtools-multitask]`. chrome-devtools-mcp's own log is at `~/.cache/chrome-devtools-mcp/mcp.log`.

## Live view: debug port and discovery file

A program on the same machine, such as a phone view of what a session is doing, can find each session's browser and attach to it.

**The debug port.** Every browser is started with `--remote-debugging-port=0`, as well as the pipe chrome-devtools-mcp talks to it over, so the pipe still carries all of the session's own traffic. Chrome picks a free port on `127.0.0.1` and writes `<profileDir>/DevToolsActivePort`: line 1 is the port, line 2 the browser's WebSocket path (`/devtools/browser/<id>`). When a slot is claimed, the last browser's leftover `DevToolsActivePort` is deleted, so the file you find belongs to the running browser. The flag is not part of the answer cache's key, so it changes nothing about how tools are answered.

**The discovery file.** While a session's browser server runs, `<CDP_HOME>/live/<pid>.json` says whose it is. `<pid>` is the plugin process of that session.

```json
{"version":1,"pid":1234,"claudePid":5678,"sessionId":"<uuid or null>","slot":3,"profileDir":"C:\\Users\\me\\.cache\\chrome-devtools-mcp\\profile-3","project":"d:\\github\\puipui","headless":false,"startedAt":1790670000000}
```

| Key | What it is |
| --- | --- |
| `version` | `1`. |
| `pid` | The plugin process, one per Claude Code session; also the file's name. |
| `claudePid` | The Claude Code process: `CLAUDE_PID` when Claude Code set it, else the plugin's parent. |
| `sessionId` | `CLAUDE_CODE_SESSION_ID` when the plugin started, or `null`. A session that is later resumed or cleared can have a newer id, so ask Claude Code for the current one. |
| `slot` | The slot number, or `null` for a throwaway profile. |
| `profileDir` | The absolute user-data-dir the browser runs on. Throwaway profiles are folders of the plugin's own (`<tmp>/cdp-mt-profile-*`), deleted when their browser closes. |
| `project` | The session's project (its git repository), lowercased on Windows. |
| `headless` | Whether the browser runs hidden. |
| `startedAt` | When this browser server started, in ms since the epoch. |

When it changes:

- It is written, whole (a temp file renamed into place), when a tool call starts the server. A session that never browses writes none.
- It is removed when the server stops: idle close, a crash, a start that timed out, or the session ending.
- `set_browser_visible` restarts the browser, so it removes the file with the old browser. The new browser writes a new one with the new `headless` and `startedAt`.
- A plugin process killed outright cannot remove its file. Check that `pid` is alive before trusting one. The next session to start a browser also deletes the files of processes that are gone.

Chrome starts a moment after the file is written, so `DevToolsActivePort` may not exist yet: poll for it. Before attaching, check that `http://127.0.0.1:<port>/json/version` answers with a `webSocketDebuggerUrl` ending in line 2.

**Who can attach.** The port listens on `127.0.0.1` only, so nothing outside the machine can reach it. Web pages cannot use it either: Chrome refuses DevTools connections from them. Any local program that finds the port can drive the browser, with the profile's sign-ins. That is the same trust as the profile files themselves, and the port number is only written inside the profile. On a machine shared with people you do not trust, set `CDP_DEBUG_PORT=0`.

## Development

```sh
npm test
```

This covers:

- unit tests for slots, the answer cache, process matching, the settings (the debug port flag, and the cache key it must not change), the live file, and the proxy, which runs against a fake server;
- an integration suite with the real chrome-devtools-mcp and headless Chrome, in a throwaway home:
  - the tools are learned once, and later sessions never start a server to ask;
  - two sessions get two browsers on two profiles;
  - the idle close frees the slot, and the next call reopens the same profile;
  - each browser answers on its debug port while chrome-devtools-mcp keeps the pipe, and the live file names its session;
  - with every slot taken, the throwaway profile is named in the live file and deleted when its browser closes.

## Credits and licences

- The plugin's own code is MIT; see `LICENSE`.
- The skills in `skills/` are copied unchanged from [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) 1.10.1. They are licensed Apache-2.0; see `skills/LICENSE-chrome-devtools-mcp` and `NOTICE`.
- The slot design started as the author's standalone `cdp-slot-chrome.mjs` wrapper.
