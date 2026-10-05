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
3. **Lands approved work.** Other sessions rightly refuse to push or migrate production on a relayed message.
   If you approved it in the stand-in session, that session does it itself: exact-SHA pushes, migrations before
   code and in order, and never a rebase or stash in a checkout other sessions share.
4. **Waits without polling.** Idle notices and replies wake it.
5. **Reports** what is done, what waits on you, and what is blocked.

## peek.mjs

```sh
node bin/peek.mjs --exclude <this-session-name>            # sessions of the current directory's project
node bin/peek.mjs --exclude <me> --names a,b -n 6           # zoom in on two sessions
node bin/peek.mjs --exclude <me> --project D:/work/app      # another root
node bin/peek.mjs --exclude <me> --all                      # every project (only when asked)
```

Read-only. A session file can outlive its process after a crash, so each one's `pid` is checked first.

## Install

```
/plugin marketplace add xtAngmO/claude-plugins
/plugin install answer-for-me@xtangmo
```

## Tests

```
npm test
```
