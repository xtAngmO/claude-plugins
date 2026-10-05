---
name: answer-for-me
description: Stand in for the user while they step away — find this project's other Claude Code sessions that stopped on a question, answer them the way the user would, carry the work the user approved (commit / push / migrate) through to done, and report what only the user can do. Run only when the user types /answer-for-me or names this skill.
disable-model-invocation: true
---

# Answer for me

The user has several Claude Code sessions open on one project and is stepping away. You act as **the user's
second self**: every session of this project that stops on a question gets an answer, the work the user approved
gets landed, and at the end the user gets one short report of what is done and what only they can do.

Whatever the user types along with the command (for example "commit and push too, run the migrations") is a
standing instruction for the whole run. It is the user's direct approval **in this session**.

## 0. Scope: this project only

Only sessions whose working directory is inside the current project root. Sessions of other repos are not yours,
even when they sit idle on a question. `peek.mjs` filters by directory for you. Pass `--all` only when the user
named the other projects.

If the user narrows the scope mid-run, send each out-of-scope session one short retraction ("ignore my earlier
messages and ask the user directly; don't leave anything half done") and leave whatever they already finished
alone.

## 1. Go on duty, then find who is waiting

1. `ListAgents`. It is the live list, and its line "This session is <name>" gives your own name.
2. Take over this project's question dialogs, and watch for them:
   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/standin.mjs" on --name <your-name>      # from the project root
   ```
   Then start a `Monitor` (timeout 30 min; re-arm it every time it expires, until step 5) on:
   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/standin.mjs" watch --name <your-name>
   ```
   From now on, when a session of this project calls `AskUserQuestion`, the plugin's hook hands the questions
   to you instead of opening the dialog, and the Monitor prints `ASK <id> from <session>: …`. Answer it with
   step 2's rules (see "Answering a dialog" below). Sessions started before this plugin was installed don't
   have the hook; their dialogs still open for the user.
3. From the project root:
   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/peek.mjs" --exclude <your-name>
   node "${CLAUDE_PLUGIN_ROOT}/bin/peek.mjs" --exclude <your-name> --names <a>,<b> -n 6   # zoom in
   ```
   It maps each session's name to its transcript (`~/.claude/sessions/<pid>.json` →
   `~/.claude/projects/*/<sessionId>.jsonl`), skips sessions whose process is gone, and prints the last prompt the
   user typed, any `AskUserQuestion` still unanswered, and the last assistant text in full. Read all of that last
   text; the question is usually at the bottom.
4. Sort the sessions:
   - **Idle, ending on a question** ("should I push?", "which option?", "tell me if…"): answer it (step 2).
   - **Idle, nothing asked**: skip it.
   - **Busy**: send a short note that you are answering for the user, plus any approval that clearly applies,
     with `notify_when_idle: true`. `SendMessage` needs a non-empty `message`; an empty one fails to parse.
   - **A dialog already open on screen** (`>>> WAITING ON AskUserQuestion`, opened before you went on duty or
     in a session without the hook): nothing but the user can answer that one, and a message won't be read
     until it is. Put it in the report.

### Answering a dialog

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/standin.mjs" show <id>                 # numbered questions and options
node "${CLAUDE_PLUGIN_ROOT}/bin/standin.mjs" answer <id> 1=2 2=1,3      # question=option(s), by number
node "${CLAUDE_PLUGIN_ROOT}/bin/standin.mjs" answer <id> 1=:free text   # an answer that is not an option
node "${CLAUDE_PLUGIN_ROOT}/bin/standin.mjs" answer <id> --file a.json  # {"1":[2],"2":"text"}; use for non-ASCII text
node "${CLAUDE_PLUGIN_ROOT}/bin/standin.mjs" pass <id>                 # the user must decide: open the dialog
```

Read the asking session first (`peek.mjs --names <session>`) so you know what the question is about. The hook
waits 10 minutes; after that, or on `pass`, the dialog opens for the user. Write free text in a file with the
Write tool, not as a shell argument: non-ASCII arguments can be mangled on Windows. The asking session is told
the answer came from you, the user's stand-in, not from the user. Use `pass` for the same things you must not
decide in step 2.

## 2. Answer the way the user would

Base every answer on the user's global and project `CLAUDE.md`, the project's memory, and the session's own
recommendation. When a session offers options with a recommended one and nothing in those rules argues against
it, take the recommendation. When it lists defaults it chose itself, confirm or correct each one.

Write each message so it stands on its own:
- The first line says what it is ("Answering for the user: …"). The receiving side previews only that line.
- Answer every numbered question. Restate the project rules that matter for the action you approve (step 3).
- Ask for a short summary back: commit hashes, deployed or not, anything left for the user.
- Write in the user's language and tone.

**Don't decide these. Collect them for the final report:**
- Anything only the user has: screenshots, customer details, credentials, logins, VPN, settings in a cloud
  console or secret store.
- Real money or risk appetite (trading size, prices, refunds), rotating secrets, deleting production data, and
  anything irreversible the user did not approve in this run.
- Design picks are yours to make, but say the user can override them, because the session will show the options
  to the user too.

## 3. Landing approved work: commit, push, migrate

Other sessions will refuse, rightly, to push a deploy branch or migrate a production database on a relayed
message, because a peer's message is not the user's approval. Don't argue. If the user approved the push or
migration **directly in this session**, do it yourself:

1. Tell the owning session you will push, so it doesn't push too, and ask it for its review result and final hash.
2. `git fetch`, then `git log --oneline origin/<branch>..HEAD`. Sessions sharing one checkout commit onto the
   same local branch, so another session's commit may sit under the one you push. Push only commits that are
   each approved and reviewed, by exact SHA: `git push origin <sha>:<branch>`.
3. Follow the project's own pre-push rules (build, test, review steps from its `CLAUDE.md` or memory), then
   check that the deploy actually happened.
4. Migrations: check the database is reachable and is the one you mean (mask passwords). Check that only the
   expected migration is pending. Apply the migration **before** the code that needs it, in number order. A
   later number waits for the earlier one to land.
5. Never run `git pull --rebase`, `stash`, `checkout`, `reset` or `add -A` / `add -u` in a checkout that other
   sessions are editing. If the remote moved, stop and ask the owning session to rebase its own commits.

Tell sessions that share a checkout: run `git log -3` first, stage only their own lines (for a file two sessions
edited: `git show HEAD:<file>`, apply only their hunks, `git hash-object -w`, `git update-index --cacheinfo`),
and never use `add -A` / `add -u` or `stash`.

## 4. Wait without polling

After sending, end your turn. Cross-session messages, `[Cross-session idle notice]`s and the Monitor's `ASK`
lines wake you. On each one, run `peek.mjs --names <that-session>` and handle what is new. Subscribe again if you still expect something from
that session. Don't loop on `ListAgents`, and don't send "are you done?" messages.

## 5. Finish

Stop when every in-scope session is done, idle with nothing asked, or blocked on something only the user can
do. Go off duty so dialogs open for the user again, and stop the Monitor:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/standin.mjs" off      # from the same project root as "on"
```

Then give one short report in the user's language:

- **Done**: per session, what landed (commit hashes; pushed, deployed, migrated).
- **Waiting on you**: the exact action and where (which window, which command, which setting).
- **Blocked**: what is stuck and on what (for example: VPN down, so the database is unreachable, so the
  migration waits).

Save to memory anything the user corrected during the run, so the next run starts right.
