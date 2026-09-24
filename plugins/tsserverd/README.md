# tsserverd

A TypeScript/JavaScript language server plugin for Claude Code. It shares **one tsserver per project root** across every Claude Code session. The official plugin starts a new tsserver in each session. tsserverd works on Windows, macOS and Linux.

## Why

The official `typescript-lsp` plugin starts `typescript-language-server`, and with it a tsserver, in every Claude Code session. Nothing is shared, not even between two sessions open in the same folder, and nothing caps the memory each one uses. On a large TypeScript repo each tsserver holds 2–4 GB. On one 64 GB Windows machine, seven open sessions held 22 GB in tsservers between them.

This is [anthropics/claude-code#87301](https://github.com/anthropics/claude-code/issues/87301), which was closed as not planned.

## How it works

```
Claude session A ─ shim ─┐
Claude session B ─ shim ─┼─► daemon (one per root) ─► typescript-language-server ─► tsserver
Claude session C ─ shim ─┘
```

- **shim** — the process Claude Code starts. It reads `initialize` to learn the session's folder. Then it connects to that folder's daemon, and starts the daemon if none is running.
- **daemon** — one per folder. It lets several sessions share one server, although LSP assumes a server has a single client:
  - **Request ids** are renumbered.
  - **`initialize`** is sent to the backend once, and later sessions get the cached answer.
  - **Open documents** are reference-counted, and each file gets one version sequence.
  - **Diagnostics** go only to the sessions that have that file open.
  - **`shutdown`/`exit`** from one session does not stop the shared server.

  The daemon exits 10 minutes after the last session leaves.
- **Fallback** — if the daemon path fails, the shim runs `typescript-language-server` itself. In the worst case you get the official plugin's behaviour; LSP keeps working.

## Install

You need Node 18.20 or newer, plus `typescript-language-server` and TypeScript 6 or older installed globally. The official plugin needs the same:

```sh
npm install -g typescript-language-server typescript@6
```

Pin `@6`. Since TypeScript 7.0 (July 2026), a plain `npm install -g typescript` installs the native compiler, which ships no `tsserver.js`. With it, `typescript-language-server` fails every `initialize` with *"Could not find a valid TypeScript installation"*. The official plugin fails the same way.

Then in Claude Code:

```
/plugin marketplace add xtAngmO/claude-plugins
/plugin install tsserverd@xtangmo
/plugin disable typescript-lsp@claude-plugins-official
```

Claude Code uses one language server per file extension, so the official plugin has to be turned off. Sessions that are already running keep their own tsserver until you close them.

## Checking it

Ask Claude for *"tsserverd status"*, or run the CLI yourself:

```sh
node ~/.claude/plugins/cache/xtangmo/tsserverd/<version>/bin/tsserverd.mjs status
```

Example output:

```
C:\Users\me\code\my-repo
  sessions 3 now · 4 at peak · 12 open files
  daemon 41236 · backend 41240 · 3.6 GB · cap 12288 MB per tsserver · since 2026-09-25T01:40:12Z

tsserver under tsserverd: 3.6 GB
tsserver outside tsserverd: 2 process(es), 6.8 GB
  (sessions started before tsserverd, or with the old typescript-lsp plugin — close them to free this)
```

`doctor` shows which `typescript-language-server` will run. `stop` stops every daemon; sessions reconnect on their next TypeScript file.

## Settings

tsserverd reads these environment variables from the environment Claude Code runs in.

| Variable | Default | What it does |
| --- | --- | --- |
| `TSD_MAX_TSSERVER_MEMORY` | `12288` | Memory cap per tsserver, in MB. A shared tsserver holds every project its sessions touch, so the V8 default of about 4 GB is too small. Setting no cap at all is how a single instance reached 61.5 GB in #87301. |
| `TSD_IDLE_MS` | `600000` | How long a daemon waits with no sessions before it exits. |
| `TSD_DISABLE` | unset | Set it to `1` to skip the daemon and behave exactly like the official plugin. |
| `TSD_REAL_TLS` | found on PATH | The `typescript-language-server` to run: its `lib/cli.mjs` or a launcher. |
| `TSD_LOG` | `<tmp>/tsserverd/tsserverd.log` (`tsserverd-<uid>` on Linux and macOS) | The lifecycle log. It records one line per event and no message traffic. |

## What is shared, and what is not

- **Sharing is per folder**, meaning the folder the Claude Code session started in. Sessions started in different folders get separate daemons, and so do git worktrees. This keeps each folder on its own TypeScript version.
- **The shared tsserver is larger than any single session's was**, because it holds every project its sessions opened. There is only one of them, though.
- **Diagnostics reach every session that has the file open.** Sessions in the same folder share one disk, so they already see each other's edits.
- **Disk is the tiebreaker.** Claude Code writes a file before it reports the change. When two sessions disagree about a file's contents, tsserverd uses what is on disk.

## Windows

The upstream project this is based on did not work on Windows. There were three separate reasons, and all three are fixed here:

- It listened on a `.sock` file path, which Windows cannot listen on. tsserverd uses a named pipe, `\\.\pipe\tsserverd-<hash>`.
- For its fallback it picked npm's extensionless `typescript-language-server` launcher. That launcher is a sh script, which Windows cannot execute. tsserverd runs the package's `lib/cli.mjs` with node directly, and uses the `.cmd` launcher, through a shell, only as a last resort.
- It compared paths and URIs exactly. Claude Code may spell a folder `c:\repo` in one session and `C:\repo` in the next. typescript-language-server also answers `file:///D:/x.ts` with diagnostics for `file:///d%3A/x.ts`. tsserverd compares the file paths themselves, and ignores case on Windows.

## Development

```sh
npm test    # broker unit tests, backend resolution, and an integration test with the real server
```

The integration test starts real shims, a real daemon and the real `typescript-language-server`. It uses its own runtime folder, so it never touches daemons you already have running.

## Credits

The design comes from [0oj/tsserverd](https://github.com/0oj/tsserverd) (MIT). This version is a rewrite. It adds Windows support, keeps the multiplexing rules in a separate module with unit tests, and makes these changes:

- per-path document keys
- `$/cancelRequest` translation
- disk-authoritative handling of ranged edits
- a memory cap for the shared tsserver
- a daemon that holds the endpoint before it starts the backend, instead of a lock directory that could go stale
