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
   **Question dialogs too:** a session stuck on an `AskUserQuestion` dialog can't read messages, so the plugin
   answers those before they open (see below).
3. **Lands approved work.** Other sessions rightly refuse to push or migrate production on a relayed message.
   If you approved it in the stand-in session, that session does it itself: exact-SHA pushes, migrations before
   code and in order, and never a rebase or stash in a checkout other sessions share.
4. **Waits without polling.** Idle notices and replies wake it.
5. **Reports** what is done, what waits on you, and what is blocked.

## Question dialogs

A dialog blocks its session until someone picks, and a cross-session message is only read at the session's next
tool round, so a message can't answer it. The plugin's `PreToolUse` hook on `AskUserQuestion`
(`bin/ask-guard.mjs`) runs in every session before the dialog opens:

- **No stand-in on for this project:** it exits at once and the dialog opens as usual.
- **Stand-in on** (`standin.mjs on`): it writes the questions to `~/.claude/answer-for-me/asks/<id>.json` and
  waits up to 10 minutes (`ANSWER_FOR_ME_WAIT_SECONDS`). The stand-in sees them through `standin.mjs watch` and
  answers with `standin.mjs answer <id> 1=2 2=1,3`. The hook then returns `allow` with the answers, so the tool
  resolves and no dialog opens. The asking session is told the answer came from the stand-in, not from you.
- **`pass`, timeout or any error:** the dialog opens for you as usual.

```sh
node bin/standin.mjs on --name <stand-in-session-name>   # from the project root
node bin/standin.mjs watch --name <name>                 # one line per new question (run under Monitor)
node bin/standin.mjs show <id>                           # numbered questions and options
node bin/standin.mjs answer <id> 1=2 2=1,3 3=:free text  # or --file answers.json for non-ASCII text
node bin/standin.mjs pass <id>                           # leave it to the user
node bin/standin.mjs off                                 # dialogs open for the user again
node bin/standin.mjs status
```

Sessions started before the plugin was installed don't have the hook, and a dialog that is already on screen
can't be taken back. Those stay for you.

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
