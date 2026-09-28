# chrome-dev-tools-multitask

A multi-session replacement for the official `chrome-devtools-mcp` plugin for Claude Code. Every session that opens a browser gets **its own Chrome window on its own persistent profile**. Sessions that never browse run **no browser server at all**. A browser nobody is using is closed after 30 minutes.

It uses the same `chrome-devtools-mcp` (1.9.0), exposes the same 29 tools, and bundles the same skills.

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

  A lock left by a process that died is taken over.
- **Sticky per project.** A slot remembers which project (git repository) last used it. A project gets its own profile back when that slot is free. A new project takes an unclaimed slot before it borrows another project's.
- **Lazy.** The plugin answers `initialize` and `tools/list` from what the real server said the first time. It starts `chrome-devtools-mcp`, and claims a slot, only when a tool is actually called. The server runs straight from npx's cache: one node process, and no telemetry watchdog.
- **Idle close.** After 30 minutes without a tool call, the server is stopped. That closes its Chrome and frees the slot. The next call starts it again on the same project's profile, so sign-ins survive, but open tabs do not.
- **Failures.** If the server or its browser dies, the calls it owed are answered with an error and the next call starts a fresh one. A browser left on a profile is closed before the slot is given back.

The slot lock files are the ones the standalone `cdp-slot-chrome.mjs` wrapper uses, so Codex running that wrapper and Claude Code running this plugin never claim the same profile.

## Install

```
/plugin marketplace add xtAngmO/claude-plugins
/plugin install chrome-dev-tools-multitask@xtangmo
/plugin disable chrome-devtools-mcp@claude-plugins-official
```

Disable the official plugin. Otherwise every session runs both servers and sees both sets of tools. Sessions that are already running keep the old one until they restart.

You need Node 20.19 or newer, and Chrome. The first time any session uses the plugin, `npx` downloads `chrome-devtools-mcp`, and that first start takes longer.

## Settings

Set these in the environment Claude Code runs in.

| Variable | Default | What it does |
| --- | --- | --- |
| `CDP_IDLE_MINUTES` | `30` | Close a browser nobody has used for this long. `0` = never. |
| `CDP_MAX_SLOTS` | `8` | Persistent profiles. Beyond this many browsers at once, a throwaway profile. |
| `CDP_MCP_VERSION` | `chrome-devtools-mcp@1.9.0` | The chrome-devtools-mcp to run. |
| `CDP_EXTRA_ARGS` | — | More chrome-devtools-mcp flags, e.g. `--headless` or `--slim`. |
| `CDP_LAZY` | on | `0` = start the server with the session, like the official plugin. |
| `CDP_HOME` | `~/.cache/chrome-devtools-mcp` | Where profiles, slots and the cache live. |

Diagnostics go to the MCP server's stderr, which is in Claude Code's MCP log. Lines start with `[chrome-devtools-multitask]`. chrome-devtools-mcp's own log is at `~/.cache/chrome-devtools-mcp/mcp.log`.

## Development

```sh
npm test
```

This covers:

- unit tests for slots and for the proxy, which runs against a fake server;
- an integration suite with the real chrome-devtools-mcp and headless Chrome, in a throwaway home:
  - the tools are learned once, and later sessions never start a server to ask;
  - two sessions get two browsers on two profiles;
  - the idle close frees the slot, and the next call reopens the same profile.

## Credits and licences

- The plugin's own code is MIT; see `LICENSE`.
- The skills in `skills/` are copied unchanged from [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) 1.9.0. They are licensed Apache-2.0; see `skills/LICENSE-chrome-devtools-mcp` and `NOTICE`.
- The slot design started as the author's standalone `cdp-slot-chrome.mjs` wrapper.
