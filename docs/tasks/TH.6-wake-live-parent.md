---
id: TH.6
title: A child that ends always wakes its parent
milestone: TH
size: S
status: done
depends_on: [TH.4]
branch: task/TH.6-wake-live-parent
lane: services
executor: claude
---

From TH.4's open question, decided by Dom on 11 Nov 2026: when a hand-off or subagent child ends, wake the parent whether the parent run is still live or has ended, and whether the child finished, was cancelled or was reaped.

Today only `completeRun` wakes, and only when the parent run has ended (`packages/services/src/runs.ts`, `runs/handoff-wake.ts`). See `docs/reviews/tasks/TH.4.md`, "Question for Dom" and "Nits left".

## Scope

- A child that ends (finished, cancelled, reaped or failed) wakes its parent in the parent's own session, with the same untrusted framing and `handoff-wake:<child id>` request id TH.4 uses. Make the wake idempotent per child, so a child that ends once wakes once.
- A live parent gets the wake as the next input in its session, queued behind the running run the way a message to a busy session is today. Don't interrupt the running run.
- The wake says how the child ended (finished, cancelled, failed or timed out).
- Keep the depth limit as it is.

## Check

- Failing tests first: live parent plus finished child, live parent plus cancelled child, ended parent plus reaped child each wake exactly once.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-11: added from Dom's decision on the TH.4 question.
- 2026-11-11: dispatched to a Sonnet implementer on task/TH.6-wake-live-parent, with a per-task review, after Dom's go.
- 2026-11-11: Merged as f2320012, review clean after 1 fix round. check, test and build passed on main. A parent that is itself a subagent is not woken, because the wake would run without the subagent's scope.
- 2026-11-11: Dom chose to keep the exception: a parent that is itself a subagent is not woken.
