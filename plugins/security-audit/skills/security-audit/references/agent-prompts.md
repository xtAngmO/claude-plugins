# Agent prompt templates (Phase 2)

Spawn every dimension in **one message** so they run concurrently. Use a general-purpose agent type (search-only
agent types locate code but don't audit it). Fill the `{…}` slots from Phase 1.

## Shared context block (paste into every prompt)

```
You are doing a READ-ONLY security audit of {REPO_PATH}.

## Context
{ONE PARAGRAPH: why now — e.g. "The owner's other app ({SIBLING}, same stack) was just hacked: (1) admin-write
endpoints had no permission check → anonymous HTML write; (2) regex SSR sanitizer → stored XSS; (3) admin lured
to the page via support chat; (4) the script used the admin's cookie to create a super-admin — no 'actor must
outrank target role' check, no audit log."}
This project: {STACK, e.g. "TanStack Start serverFns + Drizzle + sealed cookie sessions"}, {WHAT IT IS},
databases {DBS}, features {AI chat / MCP / uploads / sandbox / …}.
ATTACKER-CONTROLLED DATA (treat as hostile wherever it is rendered or fed to an LLM): {INVENTORY}.

## Rules
- READ-ONLY. Do not edit repo files, do not run migrations, do not write to or query any DB, do not send any
  request to production or any remote host. Local grep/read and small scripts are fine; put scripts in {SCRATCH}.
- Never print secret values; name the file/commit and the type of secret.
- Verify each finding by reading the code path end to end; mark anything unconfirmed as UNVERIFIED.
- For each finding: severity (Critical/High/Medium/Low) · file:line · who can exploit (anonymous / any logged-in
  user / low-privilege role / external party via stored data / LLM prompt injection) · concrete scenario · fix.
- Then a short list of things you checked that are fine.
- Keep the report under ~1000 words. Plain text.
```

## 1 · Authentication & session

```
## Your slice: AUTHENTICATION & SESSION
Files: {session/auth/permission middleware/login route paths}.
1. Secret fallbacks (`env.X || 'literal'`): is there a production boot guard? Find the deploy pipeline and decide
   whether the secrets are actually injected; does CI reject placeholder values? Does the same literal appear in
   the owner's other repos ({SIBLING_PATHS})? With the literal, what exactly must a forged cookie contain, and
   does it also need a valid DB session row bound to the same user?
2. Per request: is the session token checked against the DB (revocation)? deleted/suspended user? deleted role?
   permissions re-read or cached in the cookie?
3. Refresh flow: replay after logout/revocation? absolute lifetime cap?
4. Login: hashing algorithm/cost, rate limiting/lockout, username enumeration (messages + timing), client-IP source.
5. CSRF: GET handlers with side effects? CORS on API routes (reflected Origin + credentials)? Origin checks?
6. Logout / password change: other sessions invalidated?
```

## 2 · Authorization coverage

```
## Your slice: AUTHORIZATION COVERAGE
1. Enumerate every server entry point ({serverFns: run scripts/scan-serverfns.mjs output at {PATH}} / API routes /
   RPC). Classify each: permission-guarded · checks inside handler · own-resource only · intentionally public ·
   MISSING. For MISSING give the impact (data leaked / what can be written).
2. Raw HTTP routes ({api route dirs}) — auth on each.
3. Tenancy / IDOR: how is the tenant chosen (input, header, Referer, last-used)? Can a member of tenant A read B?
   Record-level: other users' conversations, files, tokens, recordings?
4. Route guards: every admin/sensitive page has a guard matching its endpoints' permission.
5. Mismatches: page needs `manage_x` but its endpoint needs only login/`view_x`; writes behind view permissions.
Report totals: guarded / public / own-resource / missing.
```

## 3 · Privilege escalation & account administration

```
## Your slice: PRIVILEGE ESCALATION
Files: {user mgmt, roles, sessions, tokens/OAuth, seed, schema}.
1. Can a holder of the user-admin permission (not the wildcard) create a wildcard user, change their own role,
   reset/delete a higher user? Any rank/subset check?
2. Can a holder of the role-admin permission grant the wildcard or permissions they lack, incl. to their own role?
3. Audit log for user/role/permission/password/token events? Tamper-proof?
4. On role change / delete / password reset: sessions, PATs, OAuth grants revoked?
5. Seed: default passwords? re-run resets hashes, revives deleted users, re-grants removed permissions?
6. API tokens: scope ≤ user? live vs snapshotted permissions? hashed? expiry cap? list/revoke others'?
7. From code/seed only: which roles hold escalation-capable permissions?
```

## 4 · XSS & client-side injection

```
## Your slice: XSS & CLIENT-SIDE INJECTION
1. Every HTML sink (dangerouslySetInnerHTML/innerHTML/v-html/insertAdjacentHTML/document.write): source of the
   HTML, sanitizer used, does the sanitizer also run during SSR (or fall back to regex)?
2. Chart libraries: every function `formatter` returning HTML — list each interpolated data value and its source.
3. Markdown/rich text: raw HTML allowed? mermaid securityLevel? auto-loading external images (exfiltration)?
4. href/src from data: framework version blocks `javascript:`? window.open/location from data?
5. Files served from the app origin (uploads, generated files): Content-Type exact-match bugs (charset params),
   inline vs attachment, SVG/HTML.
6. Security headers in the app/proxy config: CSP, frame-ancestors, nosniff; what would a strict CSP break?
7. CSV/xlsx formula injection (low).
You may unit-test a sanitizer locally against payloads in {SCRATCH}.
```

## 5 · AI / LLM / SQL / sandbox (skip if absent)

```
## Your slice: AI / SQL TOOLS / SANDBOX / MCP
1. Raw SQL tools: DB user (read-only role or validator-only?), table/column deny lists, readable secrets
   (password hashes, live session tokens, config/gateway secrets). Try validator bypasses locally (no DB):
   multi-statement, comments, LOAD_FILE, INTO OUTFILE, pg_read_file, dblink, COPY TO PROGRAM, data-modifying CTEs,
   sleep/benchmark, set_config, pg_terminate_backend, query_to_xml, whole-row casts.
2. Who can call them — same permission via chat and via MCP/API?
3. Sandbox: docker flags (network, privileged, caps, user, mounts, limits); who can trigger code; what code inside
   can reach; is docker.sock in the APP container (blast radius)? Is the sandbox used at all?
4. Bundle/archive extraction: zip-slip, symlinks, bombs.
5. Prompt injection: list every tool with a side effect (write, fetch URL, run code, create link/file). Can LLM
   output auto-load an attacker URL in the UI (markdown images)?
6. OAuth/MCP: redirect_uri exact match, PKCE, open registration, consent CSRF/clickjacking, hashed tokens, expiry,
   scope = live user permissions.
7. Provider keys/secrets: storage, can they reach the client or the LLM?
```

## 6 · Infra, secrets, SSRF, dependencies

```
## Your slice: INFRA, SECRETS, SSRF, FILES, DEPENDENCIES
1. Secrets in git (tracked .env, current tree, history for key prefixes) — never print values.
2. Deploy pipeline: which env vars are injected; boot/CI guards for required secrets.
3. Container: root? docker.sock? published ports? reverse-proxy config in repo?
4. Static serving: traversal, dotfiles, source maps; error pages leaking stacks.
5. SSRF: every server-side fetch whose URL/host comes from user/DB/upstream input (file:// works in Bun fetch).
6. File handling: download/stream routes (traversal, auth), presigned URLs, upload limits.
7. Dependencies: run `{bun audit|npm audit}` locally; flag criticals on pre-auth request paths (framework
   deserializers) separately from dev-only ones; "latest" ranges.
8. Debug surfaces: dev servers, test login bypasses, SQL echo active in production.
```
