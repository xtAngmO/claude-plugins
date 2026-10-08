# Fix playbook (Phase 5)

## 0. Decisions to ask first (one dialog, user's language, recommended option first)

Typical questions — only ask the ones that apply:
- Rotate the live accounts still on a seed password now (writes prod) — or code only, user rotates?
- A risky feature with zero production use (sandbox, plugin runner): turn it off + remove the infra exposure,
  move it to a separate service, or keep with minimal hardening?
- A sibling repo has the same vulnerable dependency: upgrade it too, or leave it to its own session?
- Where any new reusable artifact (skill, script) should live.

Never decide these silently. Everything else (code fixes inside the repo) proceeds without asking.

## 1. Dependencies — main agent, serial, before any fan-out

1. Upgrade the framework family together to a version that contains every fix (see 5 — not blindly the latest)
   and **pin exact versions** (replace `"latest"`).
2. `overrides` (npm/bun) / `resolutions` (yarn) for transitive criticals; keep within the same major unless
   tested.
3. Re-run the audit; list what remains and whether it's dev-only.
4. Type-check + full unit tests green **before** spawning agents — framework upgrades change types
   (e.g. a router started typing thrown errors as `unknown`).
5. **Prefer the smallest version that contains the fix, not "latest".** Green tsc / unit / build / production
   smoke is not enough: in the source audit, the latest TanStack line passed all four but made the *Vite dev
   server* hang and then crash on an aborted request — which only an e2e run that reuses one server across tests
   showed (one test passed alone, failed after its neighbour). How it was found and fixed:
   - bisect with a worktree of HEAD + only the new lockfile → same failure ⇒ dependency, not code;
   - list each candidate release's sub-package versions (`npm view <pkg>@<v> dependencies`) and pick the first
     release that carries the patched sub-package (e.g. `react-start 1.167.64` = first with
     `start-server-core 1.167.30`), plus `overrides` for the vulnerable transitive (seroval);
   - after a downgrade, delete the affected package's folder in `node_modules` and reinstall — the package
     manager can leave a nested copy of a newer transitive (a stray `zod@4`) that is no longer in the lockfile.
6. Run e2e early on the upgraded tree, before fanning out, if the project has e2e — finding a broken dev server
   after nine agents have landed costs far more.

## 2. Fan-out map (disjoint files; one `PROGRESS.md` line each)

| Agent | Owns | Must deliver |
|---|---|---|
| Users/roles | user-mgmt, roles, sessions admin, token minting, schema + migration for the audit log, seed | subset-grant rule, no self-role change, revoke-on-reset, PAT lifetime cap, append-only audit log + helper, seed with no literals that never resets/revives/re-grants, UI hides what the actor can't do |
| Session/login | session config, auth service, login page, CI env check | prod boot guard for secrets, token↔user binding, rate limit (pure, clock-injected, tested), right-most XFF, constant-time unknown-user path, absolute session cap |
| Headers/CSP/CSRF | server entry, global middleware, root document | CSP with per-request nonce (or enforced non-script policy + report-only script policy, with the reason), frame-ancestors, nosniff, Origin/Sec-Fetch-Site check exempting bearer/OAuth routes, **real-browser check on a production build with zero CSP violations** — the only agent allowed to run a server |
| HTML escaping | an `escapeHtml` util + every chart formatter / HTML sink on the client | escape after decode; shared tooltip builder; test with an `<img onerror>` name |
| AI output | file/asset serving, chat rendering, exports | base-MIME compare, attachment+sandbox for non-raster, same-origin-only images in markdown, CSV formula prefix, CSP meta in sandboxed previews |
| AI authz + sandbox + infra | chat/stream/conversations/admin/sandbox, CI, Dockerfile | server-side permission on every AI endpoint, ownership before any write, feature flag (default off) for unused risky features, `--network none`, drop docker.sock + run non-root |
| SQL tools + SSRF | SQL validator, tool descriptions, proxies | function denylist, sensitive tables, column redaction incl. `SELECT *`, whole-row tricks, https + host allowlist for upstream URLs, forced content types |
| Endpoint authz (split by directory) | controllers | permission = calling page's guard (union when shared), manage-level for writes, tenant scope from an entitlement rule; table fn → permission → why; list every role that loses access |

Rules to put in every implementation prompt:
- Own only your files; report needed changes elsewhere instead of editing them.
- Update only your `PROGRESS.md` line; never delete it.
- Others are editing concurrently: ignore type errors in files you don't own; type-check once at the end.
- Format only your files (never a repo-wide formatter run — it clobbers other agents).
- Translation/i18n files: one key per targeted edit, never rewrite the file.
- No dev servers / e2e (except the headers agent), no commits, no DB writes (except the audit-log migration).
- Tests for every pure decision function you add.
- Final report: changes with file:line, tests + results, what you couldn't do, behaviour changes users will see.

## 3. Integration (main agent)

1. Read every agent report; reconcile conflicts and requests for changes in files another agent owned.
2. Wire cross-cutting pieces (login success/failure → audit log; UI buttons other agents asked to hide).
3. Full type-check, lint on changed files, all unit tests, production build.
4. Browser pass on the production build: login, a chart page (hover a tooltip), chat, consent page; zero CSP
   violations; a cross-origin POST gets 403. Close every port you opened, even on failure.
   - Drive it with a small Playwright script that reads the login from env (never type a password through a
     tool call): load each page **directly** (the SSR path), record status, time, console errors, page errors,
     CSP violations and whether the main area has content, and screenshot each page.
   - Anything odd → load the same page on the live (old) deployment before calling it a regression. In the
     source audit, two of three suspects were pre-existing (a React #520 on one page, an empty report).
   - Other sessions may be committing to the same repo meanwhile: before fixing a type error or a broken page,
     check `git status`/`git log` for whether the file is yours (memory of the source run: HEAD moved under us
     and a sibling session's half-finished rename broke tsc for a while).
5. e2e for the flows touched, if the project has e2e.
6. Update the handoff doc (major change), delete `PROGRESS.md`.
7. Final message: what changed (by phase), what is **not committed / not deployed**, and the manual steps:
   rotate shared passwords, rotate secrets that sat on dev machines, set any new env vars in the secret store,
   firewall checks, CI runner protection.
