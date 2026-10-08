# Production facts — read-only, counts only

Four numbers changed the priority list in the source audit more than any code finding did. Get them with a
read-only connection and print **aggregates only**.

## Connection rules

- Force read-only twice: connection option `-c default_transaction_read_only=on` **and** `BEGIN READ ONLY`;
  end with `ROLLBACK`. Add `statement_timeout`.
- Read the connection string from the project's `.env` inside the script; never echo it.
- Select **no** secret columns into output. When a script must touch hashes (default-password check), compare
  in memory and print only the count.
- Keep scripts outside the repo (a scratch dir) and say so in the report.

## Queries that pay off

| Question | Why it matters |
|---|---|
| Users per role (active only) | An escalation path with 0 holders is lower urgency *today*; 18 shared-password agents is higher |
| Accounts whose hash matches the seed's literal password | Turns "seed has a default password" into "18 live accounts open to anyone who read the repo" |
| Usage of the risky feature (e.g. sandbox runs, bundles, uploads in the last N months) | 0 usage ⇒ disable + remove the infra risk instead of hardening |
| Tenancy/membership tables populated? | Decides whether a scope fix can rely on membership rows or must mirror the route guard |
| Who holds the wildcard / admin role, created when | Post-incident: spot accounts nobody recognises |
| Existing payloads in attacker-controlled fields (`<script`, `onerror`, `<svg`, `javascript:`) — counts per table/column | Shows whether someone already tried |

## Default-password check (Postgres + scrypt example)

```js
// prints only a per-role tally; never a hash, password or username
const { rows } = await client.query(
  `SELECT r.name AS role, u.password_hash AS h FROM users u JOIN roles r ON r.id = u.role_id WHERE u.deleted_at IS NULL`);
for (const row of rows) { /* scrypt(seedPassword, salt) === stored ? tally[role]++ */ }
console.table(tally);
```

Read the seed literal from the seed file at runtime (regex) so the password never appears in the transcript.
