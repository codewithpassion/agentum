---
id: EP.6
title: Answer startRun before the run is offered
milestone: EP
size: S
status: in_progress
depends_on: [EP.5]
branch: task/EP.6-app-startrun-fast
lane: services
executor: codex
---

Found on staging on 5 Nov 2026. Spec: `docs/v3/app-endpoints.md`, "Hand-off to an agent". On a warm connection a bot's `/ping` answers in about 110 ms and `/ask`, which calls `env.AGENTUM.startRun`, takes 0.8 to 1.7 s. Discord allows 3 s for the first answer, and most of that time goes on offering the run to its runtime inside the request.

## Scope
- `startRun` from an app (`packages/services/src/artifacts/app-grants.ts` through `triggers.fire`) writes the run with `offerLater: true` and returns `{ runId }` once the write is done. The offer (`runs.offerQueuedRun` as the system principal) runs after the answer, through the composition's `defer` (`waitUntil`), as the Slack route does (`packages/services/src/slack.ts` about line 530). If the deferred offer fails, log it; the minute sweep offers a run nobody offered.
- Without a `defer` in the composition, offer inline as today, so nothing is lost.
- Other `triggers.fire` callers (the token-authenticated trigger route) are unchanged.
- Check that the AppHost entrypoint's composition passes `defer`, so the deferred offer survives the response. Extend the guard in `apps/web/src/server/app-gateway/exports.test.ts` if it doesn't cover this path.
- `docs/v3/app-endpoints.md` says in one sentence that the run is offered after the response, with the sweep as backstop.

## Check
- Tests:
  - an app `startRun` returns a run id before the run is offered, and the deferred work offers it;
  - with no `defer`, the run is offered before `startRun` returns;
  - a trigger fired by token behaves as before;
  - a run whose deferred offer failed is offered by the sweep.
- `bun scripts/e2e/app-bot.ts` passes, with the reply delivered.
- `bun run check && bun run test && bun run build` pass.
- On staging, a warm `/ask` answers in under 500 ms.

## Log
- 2026-11-05: opened at Dom's request ("Do 6, then deploy") and dispatched to Codex.
