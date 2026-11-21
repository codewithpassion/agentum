---
id: SP.14
title: "A cancelled cloud or managed run sends its cost"
milestone: SP
size: S
status: done
depends_on: []
branch: task/SP.14-a-cancelled-cloud-or-managed-run-sends-i
lane: runtimes
executor: claude
---

From the SP gate review, round 2 (`docs/reviews/SP-2.md`, must-fix 1, with nit 2 folded in).

SP.13 taught `completeRun` to accept a late usage report on a cancelled run. The cloud runtime never sends one: after a cancel its last flush gets `conflict`, `step` sets `gone`, and `work` skips `completeRun`. A cancelled managed run never reads its session usage before `abandon`, so its cost is lost too.

## Scope

- Cloud (`apps/web/src/server/pi-run-core.ts`): when the platform refuses a flush because the run has ended, so `gone` is set in `work`, the runner still sends one completion that carries the run's usage. The late-report path that SP.13 added records it and runs `enforceCap`. The usage comes from a fresh read of the slice after Pi's abort, not the `slice` variable, which lacks the aborted turn. A refusal of that completion still counts as "over". Nothing else changes: no events, no reply text, no status change. A run whose final flush lands keeps today's path.
- Managed (`packages/services/src/managed/service.ts` `interrupt`): read the session usage before `abandon` and send it through the same late-report path.

## Check

- A `pi-run-core.test.ts` test with `abortLikePi`, where ingest answers `conflict` once the run is cancelled and status reads `cancelled`. After `core.cancel`, `completed` holds one result whose `usage.costUsd` covers the turns so far plus the aborted turn. The two tests in the `cancel` describe that pin `completed` to `[]` change to expect that one usage-carrying completion.
- A real-services test cancels a cloud run with a $1 agent cap and a $2 run. The run stays `cancelled`, its `usage.costUsd` is 2, and the agent is paused with reason `spend_cap`.
- A managed test: interrupting a managed run with usage records that usage on the cancelled run.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-21: added by controller from the SP gate round 2.
- 2026-11-21: dispatched.
- 2026-11-21: ready at f178e01e, review clean with no fix rounds.
- 2026-11-21: merged 347c525f, merge check passed. Done.
