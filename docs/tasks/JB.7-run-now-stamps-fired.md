---
id: JB.7
title: "Run now counts as the job firing"
milestone: JB
size: S
status: done
depends_on: [JB.5]
branch: task/JB.7-run-now-stamps-fired
lane: services-jobs
executor: claude
---

From the JB walkthrough (`docs/reviews/JB-e2e.md`). After Run now, the routines table in Edit says "Last fired: never" while the sentence says "Last run ok".

## Scope

- `jobs.runNow` stamps the trigger's `last_fired_at`, written with the run through `startRun`'s `alongside` as the cron tick does in `routines.ts`, not as a second write. `next_run_at` and `disabled_at` stay untouched (controller decision, 20 Nov 2026: the event log already counts a manual run as fired).
- Update the `jobs.test.ts` test that asserts the whole trigger row is unchanged.

## Check

- `jobs.test.ts`: after `runNow`, `lastFiredAt` is set and `nextRunAt` and `disabledAt` are unchanged.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the JB walkthrough. Rule decided by the controller under Dom's "don't wait for me".
- 2026-11-20: dispatched on task/JB.7-run-now-stamps-fired (v4 controller session).
- 2026-11-20: merged as 417aec5a, review clean after 0 fix rounds. check, test and build passed on main.
