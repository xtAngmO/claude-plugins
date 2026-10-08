# security-audit

A skill for auditing a web project the way it actually gets attacked, and then fixing it in order.

It came out of a real incident: a sibling app was taken over without cracking a single password. These four
weaknesses chained together:

1. Admin endpoints had no permission check.
2. The server-side sanitizer was regex-based and could be bypassed.
3. An admin was lured onto the infected page.
4. The create-user and change-role endpoints didn't check that the person granting a role outranks it.

The skill hunts for that kind of chain rather than for a list of vulnerability names.

```
/plugin install security-audit@xtangmo
```

Then ask for it in plain words, for example "security check this project", "ตรวจ security หน่อย", or "my other site got hacked, will this one?".

## What it does

| Phase | What happens |
| --- | --- |
| Orient | Reads the handoff doc. Lists the attacker-controlled data: anything outsiders write that staff see, or that an LLM reads. Runs quick greps and one `curl -sI` of production. |
| Audit | Spawns 6 read-only agents in one message: auth/session, authorization coverage, privilege escalation, XSS, AI/LLM/SQL/sandbox, and infra/secrets/dependencies. |
| Verify | Re-reads the code behind every Critical and High finding, runs the dependency audit, and pulls production facts read-only as counts only. Examples: accounts still on the seed password, users per role, whether a risky feature is used at all. |
| Report | Opens with a direct answer. Then: a table mapping the known attack chain onto this project, Critical/High/Medium with `file:line`, what's already solid, what needs a human check, and the fix order. |
| Fix | Only on request. Asks about anything that touches production first, in the user's language. Upgrades dependencies serially. Then fans out implementation agents with disjoint file ownership (tracked in `PROGRESS.md`), and integrates with a browser pass on a production build. |

It never sends attack payloads to a live system and never prints secret values.

## Files

```
skills/security-audit/SKILL.md                 the workflow
skills/security-audit/references/checklist.md  patterns that became real findings, how to confirm, how to fix
skills/security-audit/references/agent-prompts.md   prompt templates for the 6 audit agents
skills/security-audit/references/prod-facts.md      read-only production queries that change priorities
skills/security-audit/references/fix-playbook.md    decisions to ask, fan-out map, integration steps
skills/security-audit/scripts/scan-serverfns.mjs    TanStack Start: every createServerFn + the middleware guarding it
```

### scan-serverfns.mjs

```
node scan-serverfns.mjs <repoRoot> [--src src] [--json] [--permission-pattern <re>] [--auth-pattern <re>]
```

The script classifies every server function as one of:

- **permission**: guarded by a permission check;
- **auth-only**: requires login only;
- **none**: no guard at all.

It follows same-file aliases, so a guard named `const adminOnly = authMiddleware` is reported as auth-only. It also flags handler bodies that check permissions or ownership themselves. It has no dependencies and runs on node 18+ or bun. Tests: `npm test`.
