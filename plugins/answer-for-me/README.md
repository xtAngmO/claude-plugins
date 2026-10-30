# answer-for-me

Stand in for yourself across your other Claude Code sessions. Type `/answer-for-me` in one session before you step
away. That session finds the other sessions of the same project that stopped on a question and answers them the
way you would. It lands the work you approved, waits for the rest, and gives you one report at the end.

Claude never starts it on its own (`disable-model-invocation: true`). It runs only when you type the command.

```
/answer-for-me commit and push when they're done, run the migrations too
```

## What it does

1. **Finds who is waiting.** `bin/peek.mjs` reads Claude Code's session registry (`~/.claude/sessions/*.json`)
   and each session's transcript. It lists the live sessions **of this project only** and, for each one, the
   last prompt you typed, any `AskUserQuestion` still open, and the last thing the assistant said.
2. **Answers like you.** It bases each answer on your `CLAUDE.md`, the project's memory, and the session's own
   recommendation, and sends it with `SendMessage`. It does not decide things only you can: screenshots,
   credentials, VPN, real money, rotating secrets, irreversible data changes. Those go into the report.
   **Question dialogs too:** a session stuck on an `AskUserQuestion` dialog can't read messages, so a hook
   offers each open dialog to the stand-in, even one opened before it went on duty (see below).
3. **Lands approved work.** Other sessions rightly refuse to push or migrate production on a relayed message.
   If you approved it in the stand-in session, that session does it itself: exact-SHA pushes, migrations before
   code and in order, and never a rebase or stash in a checkout other sessions share.
4. **Waits without polling.** Idle notices and replies wake it.
5. **Reports** what is done, what waits on you, and what is blocked.

## Question dialogs

A dialog blocks its session until someone picks, and a cross-session message is only read at the session's next
tool round, so a message can't answer it. The plugin's `PermissionRequest` hook on `AskUserQuestion`
(`bin/ask-guard.mjs`) runs in every session, alongside the open dialog. Whoever answers first wins: you in the
dialog, or the stand-in.

- **Every dialog is offered.** When a dialog opens, the hook writes its questions to
  `~/.claude/answer-for-me/asks/<id>.json`, whether or not a stand-in is on, and waits. A stand-in that goes on
  duty later (`standin.mjs on`) still sees the dialogs that are already open.
- **Added folders count.** A session you gave another folder (the desktop app's "add folder") may ask from
  that folder. The ask still belongs to the session's own root (`cwd` in `~/.claude/sessions/<pid>.json`), so
  a stand-in on duty at either one gets it.
- **The dialog is always on your screen,** even when a stand-in is on. You can still answer it yourself.
- **The stand-in answers:** it sees the ask through `standin.mjs watch` and answers with
  `standin.mjs answer <id> 1=2 2=1,3`. The hook returns `allow` with the answers, the tool resolves with them and
  the dialog closes. The asking session is told the answer came from the stand-in, not from you.
- **You answer first:** the hook sees your answer in the session's transcript and stops waiting. The stand-in's
  answer is then not used, and `answer` says so.
- **`pass`, the session exits, or any error:** the hook stops waiting and the dialog stays yours.
- **How long it waits:** `ANSWER_FOR_ME_WAIT_SECONDS`, default 86000 (about a day). In a subagent Claude Code
  waits for the hook before it shows the dialog, so there the hook waits only when a stand-in is already on, and
  only 600 seconds by default.

```sh
node bin/standin.mjs on --name <stand-in-session-name>   # from the project root; says how many dialogs are open
node bin/standin.mjs watch --name <name>                 # open dialogs, ones already open first (run under Monitor)
node bin/standin.mjs show <id>                           # numbered questions and options
node bin/standin.mjs answer <id> 1=2 2=1,3 3=:free text  # or --file answers.json for non-ASCII text
node bin/standin.mjs pass <id>                           # leave it to the user (the dialog stays on screen)
node bin/standin.mjs off                                 # dialogs are the user's alone again
node bin/standin.mjs status                              # every open dialog and which stand-in covers it
```

`answer` and `pass` wait a few seconds for the hook and say how it ended: delivered (the dialog closed), you had
already answered in the dialog, or the asking session has exited.

Sessions started before 1.2.0 was installed keep the 1.1.0 hook until they restart. That hook only hands a dialog
over when a stand-in is already on, so a dialog they open while no stand-in is on stays yours.

## peek.mjs

```sh
node bin/peek.mjs --exclude <this-session-name>            # sessions of the current directory's project
node bin/peek.mjs --exclude <me> --names a,b -n 6           # zoom in on two sessions
node bin/peek.mjs --exclude <me> --project D:/work/app      # another root
node bin/peek.mjs --exclude <me> --all                      # every project (only when asked)
```

Each open `AskUserQuestion` shows its ask id when the stand-in can answer it, or says only you can.
Read-only. A session file can outlive its process after a crash, so each one's `pid` is checked first.

## Install

```
/plugin marketplace add xtAngmO/claude-plugins
/plugin install answer-for-me@xtangmo
```

## Tests

```
npm test
STANDIN_NAME=<a live session's name> node scripts/e2e.mjs   # against a real claude; calls the API
```

`scripts/e2e.mjs` runs claude the way the desktop app does (stream-json, `--permission-prompt-tool=stdio`) and
checks both races: a stand-in that comes on after the dialog opened answers it, and the hook leaves when you
answer first. Run it after a Claude Code update.
