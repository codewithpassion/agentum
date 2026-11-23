---
id: FX.6
title: "Connector refresh tests are stable under load"
milestone: FX
size: S
status: in_progress
depends_on: []
branch: null
lane: e2e-scripts
executor: claude
---

The FX.4 merge check failed on two tests in `apps/web/src/server/routes/proxy.test.ts`, in the `refreshing` describe. "a lease holder that dies leaves a lease that expires in 30 s, and the next caller takes it" got `NaN` at line 802. "--fail-once with no refresh token sets needs_auth and appends connector.needs_auth" saw 1 token call where it expected 0, at line 834. The file passes 51 of 51 when run alone, three times in a row. The full run was at a high load average with six dispatchers testing.

## Scope

- Find why these two tests depend on timing or on state left by an earlier test: a real clock where a fake one belongs, a stub whose counters carry over, or a lease row left behind. Fix the cause and keep what the tests assert.
- If other tests in the `refreshing` describe share the cause, fix them too and list them in the review file.

## Check

- Remove the `.skip` FX.7 added and take the entry out of `docs/backlog/flaky-tests.md`. The fix removes the timing or shared-state dependence itself (fake clock, per-test state, a readiness wait instead of a sleep), so the test does not depend on machine load. It passes 5 times in a row run alone. Never generate load to reproduce: no parallel test runs, no busy loops, no stress tools (Dom's rule).
- `bun run check` and the changed packages' tests and build pass.

## Log
- 2026-11-21: added by controller after the FX.4 merge check failed on these two tests.
- 2026-11-21: deferred to the backlog on Dom's scope freeze (only must-fix bugs stay in v4).
- 2026-11-23: back in scope on Dom's call. Controller amended the Check: re-enable the FX.7-skipped tests, no load generation.
- 2026-11-23: dispatched.
