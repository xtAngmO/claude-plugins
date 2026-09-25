# typescript-lsp (xtangmo)

A drop-in replacement for the official `typescript-lsp` plugin for Claude Code. It runs **one tsserver per TypeScript project** and shares it with every Claude Code session that touches that project. The official plugin starts one tsserver per session. It works on Windows, macOS and Linux.

Inside, the engine is called **tsserverd**. That is the name of its status CLI, its skill, its log folder and its `TSD_*` settings.

## Why

The official `typescript-lsp` plugin starts `typescript-language-server`, and with it a tsserver, in every Claude Code session. Nothing is shared, not even between two sessions in the same folder, and nothing caps the memory each one uses. On a large repo each tsserver holds 2–4 GB. On one 64 GB Windows machine, seven open sessions held 22 GB in tsservers between them.

This is [anthropics/claude-code#87301](https://github.com/anthropics/claude-code/issues/87301), which was closed as not planned.

## Measured

Three sessions started in different folders (a parent folder, the repo, and `src/` inside it) all edit the same file of a 239-file TypeScript repo:

| | Memory | tsservers | TypeScript used |
| --- | --- | --- | --- |
| official `typescript-lsp` | 3.02 GB | 3 | the parent-folder session gets the global TS (6.0.3), not the repo's |
| tsserverd | **1.07 GB** | **1** | the repo's own (5.9.3), for all three |

The saving grows with every extra session. On a large repo (3–4 GB per tsserver) three sessions go from ~10 GB to ~3.5 GB.

## How it works

```
Claude session A ─ shim ─┬─────────► daemon: repo-web ─► typescript-language-server ─► tsserver
Claude session B ─ shim ─┤    ┌────►
Claude session C ─ shim ─┴────┴────► daemon: repo-api ─► typescript-language-server ─► tsserver
```

- **The shim** is the process Claude Code starts, one per session. It routes each file to the server of the file's *project*: the nearest folder with its own `node_modules/typescript`.
  - It routes by file, not by where the session started or which folder it `cd`ed into. So every session that touches `repo-web` shares `repo-web`'s tsserver.
  - A session that works across several repos is served by several projects at once.
  - It answers `initialize` from cached capabilities, so no server starts until a TS/JS file is actually touched.
- **The daemon**, one per project, lets several sessions share one server, although LSP assumes a server has a single client:
  - request ids are renumbered;
  - `initialize` reaches the server once;
  - open documents are reference-counted, with one version sequence per file;
  - diagnostics go only to the sessions that have the file open;
  - one session's `shutdown` does not stop the server.
- **Memory is handed back.**
  - A session that has not touched a project for 15 minutes lets go of it.
  - A daemon with no sessions left exits 5 minutes later, and its tsserver goes with it.
  - Touching the project again brings the server back and re-opens the session's files.
- **Nothing that does not help Claude is started.** typescript-language-server's second, syntax-only tsserver and its @types downloader are off. Together they cost about 230 MB per project.
- **Failures stay small.**
  - If a project's server crashes, the next edit starts a new one. The session and its other projects never notice.
  - If a daemon cannot be reached, that project gets a private server, so the worst case is the official plugin's behaviour.

## Install

You need Node 18.20 or newer, plus `typescript-language-server` and TypeScript 6 or older installed globally. The official plugin needs the same:

```sh
npm install -g typescript-language-server typescript@6
```

Pin `@6`. Since TypeScript 7.0 (July 2026), a plain `npm install -g typescript` installs the native compiler, which ships no `tsserver.js`, and `typescript-language-server` cannot start. The global TypeScript is only used for files that are not in a project with its own TypeScript.

Then in Claude Code:

```
/plugin marketplace add xtAngmO/claude-plugins
/plugin install typescript-lsp@xtangmo
/plugin disable typescript-lsp@claude-plugins-official
```

Claude Code uses one language server per file extension, so the official plugin has to be turned off. Sessions that are already running keep their own tsserver until you restart them.

## Checking it

Ask Claude for *"tsserverd status"*, or run the CLI yourself:

```sh
node ~/.claude/plugins/cache/xtangmo/typescript-lsp/<version>/bin/tsserverd.mjs status
```

Example output:

```
C:\Users\me\code\my-repo
  sessions 3 now · 3 at peak · 4 open files · TypeScript 5.9.3
  daemon 41236 · backend 41240 · 1.0 GB · cap 12288 MB per tsserver · since 2026-09-25T01:40:12Z

tsserver under tsserverd: 1.0 GB
tsserver outside tsserverd: 2 process(es), 6.8 GB
  (sessions started before tsserverd, or with the old typescript-lsp plugin — close them to free this)
```

`doctor` shows which `typescript-language-server` will run. `stop` stops every daemon; sessions reconnect on their next TypeScript file.

## Settings

tsserverd reads these environment variables from the environment Claude Code runs in.

| Variable | Default | What it does |
| --- | --- | --- |
| `TSD_PROJECT_IDLE_MS` | `900000` (15 min) | How long a session keeps a project it is not using. |
| `TSD_IDLE_MS` | `300000` (5 min) | How long a daemon with no sessions waits before it exits. |
| `TSD_MAX_TSSERVER_MEMORY` | `12288` | Memory cap per tsserver, in MB. It is a ceiling, not a reservation. With no cap, a single instance reached 61.5 GB in #87301. |
| `TSD_SYNTAX_SERVER` | `never` | Set it to `auto` to keep typescript-language-server's syntax-only tsserver, which answers a little sooner while a big project is still loading. |
| `TSD_TYPE_ACQUISITION` | off | Set it to `on` to download `@types` for plain JavaScript projects that have no `node_modules`. |
| `TSD_DISABLE` | unset | Set it to `1` to skip all of the above and behave exactly like the official plugin. |
| `TSD_REAL_TLS` | found on PATH | The `typescript-language-server` to run: its `lib/cli.mjs` or a launcher. |
| `TSD_LOG` | `<tmp>/tsserverd/tsserverd.log` (`tsserverd-<uid>` on Linux and macOS) | The lifecycle log. It records one line per event and no message traffic. |

## What is shared, and what is not

- **A project is the nearest folder with its own `node_modules/typescript`.**
  - A monorepo with hoisted dependencies is one project.
  - A package with its own TypeScript is its own project.
  - A file inside `node_modules` belongs to the project that installed it.
  - A folder whose TypeScript is version 7 is skipped, because it has no `tsserver.js`.
- **Files outside any project** are checked with the global TypeScript, and grouped by git repository.
- **Diagnostics reach every session that has the file open.** Sessions share one disk, so they see each other's saved edits either way.
- **Disk is the tiebreaker.** Claude Code writes a file before it reports the change. When two sessions disagree about a file's contents, tsserverd uses what is on disk.
- **`workspace/symbol`** searches every project the session is currently connected to, and merges the results.

## Windows

The upstream project this is based on did not work on Windows. There were three separate reasons, and all three are fixed here:

- It listened on a `.sock` file path, which Windows cannot listen on. tsserverd uses a named pipe, `\\.\pipe\tsserverd-<hash>`.
- For its fallback it picked npm's extensionless `typescript-language-server` launcher. That launcher is a sh script, which Windows cannot execute. tsserverd runs the package's `lib/cli.mjs` with node directly, and uses the `.cmd` launcher, through a shell and quoted, only as a last resort.
- It compared paths and URIs exactly. typescript-language-server answers `file:///D:/x.ts` with diagnostics for `file:///d%3A/x.ts`, and Claude Code may spell a folder `c:\repo` in one session and `C:\repo` in the next. tsserverd compares file paths, and ignores case on Windows.

## Development

```sh
npm test
```

This covers:

- the broker, the router and project resolution, as unit tests;
- backend resolution;
- an integration suite run with real processes, which covers:
  - routing across two projects;
  - sharing between sessions rooted in different folders;
  - releasing a project and reconnecting to it;
  - recovering from a crash;
  - falling back to a private server;
  - three sessions starting at once.

The integration suite uses its own runtime folder, so it never touches daemons you already have running.

## Credits

The multiplexing design comes from [0oj/tsserverd](https://github.com/0oj/tsserverd) (MIT). This is a rewrite that adds:

- Windows support;
- routing per project instead of per session;
- idle release;
- the lean server settings;
- crash recovery per project;
- `$/cancelRequest` translation;
- disk-authoritative edits;
- a memory cap;
- a daemon that holds its endpoint before it starts the backend.
