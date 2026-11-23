---
id: FX.5
title: "The guest execution test survives a loaded machine"
milestone: FX
size: S
status: in_progress
depends_on: [FX.4]
branch: null
lane: e2e-scripts
executor: claude
---

FX.4's dispatcher saw `guest-execution.test.ts` (apps/web) fail twice in full `bun run test` runs with a Miniflare `ECONNRESET`, at a load average of 70 or more. It passes when run alone.

## Scope

- Find why the test's Miniflare connection resets under load: a startup race, a too-short timeout, or a shared port. Fix the cause in the test or its helper, not by retrying blindly. FX.1 fixed similar workerd flakes, so read its task file and review first.
- If the cause is pure slowness, give the test a timeout that fits a loaded machine, with a comment saying why.
- Don't change what the test asserts.

## Check

- Remove the `.skip` FX.7 added and take the entry out of `docs/backlog/flaky-tests.md`. The fix removes the timing or shared-state dependence itself (fake clock, per-test state, a readiness wait instead of a sleep), so the test does not depend on machine load. It passes 5 times in a row run alone. Never generate load to reproduce: no parallel test runs, no busy loops, no stress tools (Dom's rule).
- `bun run check` and the changed packages' tests and build pass.

## Log
- 2026-11-21: added by controller from the FX.4 report.
- 2026-11-21: dispatched.
- 2026-11-21: deferred to the backlog on Dom's scope freeze (only must-fix bugs stay in v4).
- 2026-11-23: back in scope on Dom's call. Controller amended the Check: re-enable the FX.7-skipped tests, no load generation.
- 2026-11-23: dispatched.
