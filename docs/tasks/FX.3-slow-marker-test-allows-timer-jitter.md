---
id: FX.3
title: "The SLOW marker test allows timer jitter"
milestone: FX
size: S
status: in_progress
depends_on: []
branch: task/FX.3-slow-marker-test-allows-timer-jitter
lane: e2e-scripts
executor: claude
---

Found by the SP.8 dispatcher. `scripts/e2e/a2a-fake-openai.test.ts` "waits at least 200 ms for a SLOW marker" failed once with 199.65 ms on a loaded machine and passed on the re-run. A timer can fire a fraction of a millisecond early when measured with `performance.now()`.

## Scope

Make the assertion allow a few milliseconds of timer jitter, for example `toBeGreaterThanOrEqual(190)`, with a one-line comment saying why. Change nothing else.

## Check

- The test passes 20 runs in a row: `for i in $(seq 20); do bun test scripts/e2e/a2a-fake-openai.test.ts || break; done`.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-21: added by controller from the SP.8 report. Dispatched.
- 2026-11-21: ready at 296074e1, review clean with no fix rounds. Queued for merge.
