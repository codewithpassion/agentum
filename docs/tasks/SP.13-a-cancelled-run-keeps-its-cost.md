---
id: SP.13
title: "A cancelled run keeps its cost"
milestone: SP
size: S
status: in_progress
depends_on: []
branch: task/SP.13-a-cancelled-run-keeps-its-cost
lane: services-spend
executor: claude
---

From the SP gate review, round 1 (`docs/reviews/SP-1.md`, must-fix 3).

## Scope

a run that ends `cancelled` or `interrupted` keeps the usage its runtime reports afterwards. `completeRun` accepts a late report on such a run and writes only `usage`, with no change to status, reply or events. `enforceCap` then runs. The cloud runtime still sends its result after an abort, as it does today, and that result now lands. `abortedCompletion` stores `usage` when a completion carries it. The machine client is out of scope: it sends no usage on abort, and machine cancels stay uncounted. Record that in the task log.

## Check

a runs service test where a run is cancelled and then gets `completeRun` with `{ status: "failed", usage: { costUsd: 2 } }`. The run stays `cancelled`, its `usage.costUsd` is 2, and with a $1 cap the agent is paused. An `aborted` completion that carries usage stores it. `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-21: added from the SP gate review, round 1.
- 2026-11-21: dispatched.
