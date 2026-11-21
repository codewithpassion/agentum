---
id: FX.6
title: "Connector refresh tests are stable under load"
milestone: FX
size: S
status: todo
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

- `proxy.test.ts` passes 10 times in a row while another `bun run test` runs alongside it.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-21: added by controller after the FX.4 merge check failed on these two tests.
