---
id: JB.6
title: "The card says how the last run went"
milestone: JB
size: S
status: in_progress
depends_on: [JB.5]
branch: task/JB.6-card-last-run
lane: services-roster
executor: claude
---

From the JB walkthrough (`docs/reviews/JB-e2e.md`). After a successful run the agent card still reads "Idle. Next run ...", so home shows nothing about a finished run.

## Scope

- In `roster.ts` `activityFor`: when the last run finished ok within the last 24 hours and nothing is waiting or running, the line reads "Done <finish time>: <run title>. Next run <time>" (or "Done <finish time>: <run title>" without a schedule). Use a fixed clock time such as "Done 9:04 am", not "4 minutes ago". After 24 hours it goes back to "Idle. Next run ..." (controller decision for Dom, 20 Nov 2026).
- `RunFact` carries the finish time, the last run's title (and mail subject) is computed as it is for running runs, and `activityFor` takes `now` for the 24-hour rule.
- Failed, stopped, waiting and running lines stay as they are.

## Check

- `roster.test.ts` covers: last run done within a day, done over a day ago, last run failed (unchanged), a run waiting (unchanged).
- Browser with the fake runtime: Run now on a job, open home, the card shows the new line at desktop and phone size.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the JB walkthrough. Wording decided by the controller under Dom's "don't wait for me".
- 2026-11-20: dispatched on task/JB.6-card-last-run (v4 controller session).
