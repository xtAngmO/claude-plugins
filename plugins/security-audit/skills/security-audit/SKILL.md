---
name: security-audit
description: Audit a web project for the attack chains that actually get apps hacked — unguarded endpoints, stored XSS that reaches a staff browser, privilege escalation through user/role admin, forgeable sessions, AI/LLM tool abuse, sandbox/infra blast radius, vulnerable framework deserializers — then (if asked) fix them in priority order with parallel agents. Use when the user asks for a security check/audit/review of a project, asks "will this get hacked?", "ตรวจ security", "เช็คช่องโหว่", "โดน hack ไหม", or after an incident in a sibling project ("another site of mine got hacked, check this one"). Read-only against production: never sends attack payloads.
---

# Security audit — find the chain, prove it, fix it in order

A real incident shaped this skill. A sibling app was taken over without a single password being
cracked:

1. admin-write endpoints had **no permission check** → an anonymous attacker wrote HTML into an announcement;
2. the **server-side sanitizer was regex** (the DOM-based one only ran in the browser) → the HTML kept its script;
3. the attacker **chatted with support** until an admin opened the page;
4. the script ran with the admin's cookie and called **create-user / change-role**, which never checked that the
   actor outranks the role being granted → two new super-admins, **no audit log** to show what else happened.

Audit for that *chain*, not for a list of CWE names. A Medium XSS plus a Medium "manager can grant any role" is a
Critical takeover. The full pattern list is in [`references/checklist.md`](references/checklist.md).

## Ground rules (non-negotiable)

- **Read-only against production.** At most: one plain `GET` to read response headers, and read-only DB queries
  (`BEGIN READ ONLY` + `default_transaction_read_only=on`) that **print counts, never values** — no hashes, tokens,
  secrets, or personal data in the transcript. Never send exploit payloads to a live system, never forge a cookie
  against prod "to prove it". Say "not tested" instead.
- **Never print secrets** found in the repo, `.env`, or git history — name the file/commit and the secret type.
- **Answer in the user's language**, including `AskUserQuestion` dialogs (a user rejected an English dialog).
- **Ask before anything that touches production or another repo**: rotating passwords, disabling a feature,
  migrations, deploy config, upgrading a sibling project. Offer a recommended option.

## Phase 1 — Orient (main agent, ~5 min)

1. Read the project handoff doc (`PROJECT.md`) / knowledge graph if present; don't scan the tree blind.
2. Identify: framework + how server code is reached (server functions, API routes, RPC), session mechanism,
   permission model (roles/permissions/tenancy), databases, deploy shape (Dockerfile, CI, reverse proxy).
3. **Inventory attacker-controlled data** — the most important list in the audit. Anything an outsider can write
   that staff will later *see* or that an LLM will *read*: customer names/companies from an external system
   (WHMCS, CRM, shop sign-up), chat/support messages, tickets, reviews, uploaded files, call transcripts, webhook
   payloads, other teams' databases, LLM output itself.
4. Quick greps that pay off immediately:
   - `process.env.\w+ \|\| '` (hardcoded secret fallbacks), `dangerouslySetInnerHTML|innerHTML|v-html`,
     `formatter` (chart tooltips render HTML), `docker.sock`, `createServerFn`/route handlers count.
5. One plain `curl -sI` of the production URL → which security headers actually ship (CSP? frame-ancestors?).

## Phase 2 — Fan out the audit (one agent per dimension, all in ONE message)

Spawn read-only agents in parallel, one per dimension. Prompt templates, including the shared context block
and output format, are in [`references/agent-prompts.md`](references/agent-prompts.md):

| # | Dimension | Typical killer finding |
|---|---|---|
| 1 | Authentication & session | secret falls back to a literal; cookie userId not bound to the session row |
| 2 | Authorization coverage | login-only endpoints; tenant picked from `Referer`/body without membership check |
| 3 | Privilege escalation & admin | `manage_users` can grant the wildcard role; no audit log; reset doesn't revoke sessions |
| 4 | XSS & client injection | chart tooltip formatter interpolates customer names; same-origin HTML/SVG files |
| 5 | AI / LLM / SQL / sandbox (if present) | prompt injection → admin's raw-SQL tool; markdown image exfil; docker.sock |
| 6 | Infra, secrets, SSRF, dependencies | pre-auth deserializer CVE in the framework; prod secrets on a dev box |

Drop dimension 5 if there is no AI/sandbox; split dimension 2 by directory if there are hundreds of endpoints.
For TanStack Start projects, [`scripts/scan-serverfns.mjs`](scripts/scan-serverfns.mjs) lists every server
function and the middleware guarding it — give its output to agent 2.

## Phase 3 — Verify before you report (main agent)

Agents disagree and over-claim. In the source incident, two agents contradicted each other on whether generated
HTML files got a sandbox CSP; reading one line settled it (the check compared `'text/html; charset=utf-8'` to
`'text/html'` — never true). So:

1. **Read the code behind every Critical/High yourself** (2–3 targeted reads, not a re-audit).
2. **Run the dependency audit yourself** (`bun audit` / `npm audit --omit=dev` / `pip-audit`) and check whether a
   critical sits on a **pre-auth path** (e.g. the framework's request deserializer). Compare sibling repos' lockfiles.
3. **Pull the production facts that change priority**, read-only, counts only
   ([`references/prod-facts.md`](references/prod-facts.md)):
   - how many active accounts still use a password hardcoded in the seed (compare hashes locally);
   - how many users hold each escalation-capable role (0 managers ⇒ the escalation has no actor *today*);
   - whether the risky feature is used at all (0 sandbox runs ⇒ turn it off rather than harden it);
   - tenancy tables actually populated? (an unpopulated membership table changes how a scope fix must work).

## Phase 4 — Report

Lead with the direct answer ("yes, the same chain works here, and in places it's worse"), then:

1. **The chain table**: each step of the known attack → how it maps onto this project (with `file:line`).
2. **Critical / High / Medium**, each: what, `file:line`, who can exploit (anonymous / any staff / low-priv role /
   external customer via stored data / LLM prompt injection), one-line scenario.
3. **What's already solid** (short — it tells the user what not to touch).
4. **What needs a human check** (Vault values, firewall, runner settings) — things code can't show.
5. **Fix order** P0 (today) / P1 / P2, and ask which to start. Mark anything untested as untested.

## Phase 5 — Fix (only when the user says go)

Follow [`references/fix-playbook.md`](references/fix-playbook.md). The shape that worked:

1. **Ask the production-touching decisions first**, in the user's language, in one dialog (≤4 questions).
2. **Dependency upgrades first, serially, by the main agent** — the lockfile and `node_modules` are shared by every
   agent's type-check. Pick the smallest release that carries each fix, pin exact versions (no `"latest"`), add
   `overrides` for transitive criticals, then type-check + unit tests **and an e2e run** green before fanning out
   (a framework upgrade once passed tsc/unit/build/prod but killed the dev server — see the playbook).
3. **Fan out with disjoint file ownership** (`PROGRESS.md`, one line per agent): users/roles+audit log ·
   session/login · headers/CSP/CSRF (the only agent allowed to run a server) · chart/HTML escaping · AI output ·
   AI authz+sandbox+infra · SQL tool guards+SSRF · endpoint authz split by directory.
4. **Integrate**: wire cross-cutting bits (e.g. login events into the new audit log), full type-check, all unit
   tests, production build, a browser pass with zero CSP violations, e2e where the project has it. Update the
   handoff doc. Report what is **not yet deployed / not committed** and what the user must do by hand
   (rotate passwords, set new env vars, rotate secrets that sat on a dev machine).

## Anti-patterns this skill exists to stop

- Reporting a scanner's raw output without reading the code.
- "Login required" treated as "authorized".
- Hardening a feature nobody uses instead of turning it off.
- A deny-list sanitizer or regex HTML cleaner presented as a security boundary.
- Fixing the XSS but leaving the escalation (or vice versa) — break the chain in at least two places.
- Probing production to "confirm" an exploit.
