---
name: test-every-change
description: Run the test suite green after EVERY change — minor or major. Always run unit and integration tests for the code you touched; when the project has BOTH a backend and a frontend, also run end-to-end tests across the stack. Use whenever you finish editing code, before reporting a task done.
---

# Test every change — minor or major

Every change ships with its tests run **green**. This applies to **minor and major** changes alike (unlike
the handoff-doc update, which is major-only) — a one-line fix gets tested just like a new feature. **Don't
report a task done until the relevant tests pass**; if they fail, surface the failure and the output —
don't bury it or claim success.

## Always: unit + integration

1. **Unit tests.** Run them for the code you touched (`<UNIT_TEST_CMD>`), and **add or update** unit tests
   for any new or changed behaviour — running a stale suite that doesn't cover your change isn't enough.
2. **Integration tests.** Run them (`<INTEGRATION_TEST_CMD>`) so cross-module / DB / API-boundary behaviour
   is exercised, not just isolated units.

## When the project has both a backend and a frontend: end-to-end

3. **E2E tests.** If the repo ships **both** a backend and a frontend, run the end-to-end suite
   (`<E2E_TEST_CMD>`) so a real user flow is verified across the stack (UI → API → DB → back), and add an
   E2E case for any new user-facing flow. If the project is single-tier (backend-only or frontend-only),
   **skip E2E** — unit + integration still apply.

## Scope it to the change

- Run the **targeted** tests for the package/area you changed first (fast feedback), then the **full** suite
  before declaring done.
- New behaviour ⇒ a new test. A bug fix ⇒ a **regression test** that fails before the fix and passes after.
- Don't weaken a test to make it pass; fix the code or the test's wrong expectation.

## In a parallel run

Each agent runs the tests for **its own slice** before marking its `PROGRESS.md` line `done`. The **main
agent** then runs the **full** unit + integration (+ E2E) suite once over the combined change during
synthesis (see the `parallel-subtasks` skill) — a slice passing in isolation doesn't guarantee the merged
result is green.
