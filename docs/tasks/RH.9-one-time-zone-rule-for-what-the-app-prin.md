---
id: RH.9
title: "One time zone rule for what the app prints"
milestone: RH
size: S
status: done
depends_on: [RH.7]
branch: task/RH.9-one-time-zone-rule-for-what-the-app-prin
lane: web-thread
executor: claude
---

From the RH walkthrough (`docs/reviews/RH-e2e.md`).

Chat and task times print the UTC `HH:MM` of the ISO string (`slice(11, 16)` in `components/thread/task-thread.tsx`, `components/task/thread-runs.tsx`, `components/task/task-page.tsx` and `components/requests/request-card-logic.ts`). At 20:13 in Sydney the chat said 09:13. The desk pane's "How it got here" uses the browser's zone. The card status line uses the workspace zone (UTC by default). Three zones on one screen.

## Decision

Controller decision (under Dom's "don't wait for me", 20 Nov 2026): times of things that happened (messages, tasks, logs, the card status line) show in the viewer's browser time zone. Schedules (a job's next run, the dream time) show in the workspace time zone with the zone named, because that is the zone they run in.

## Scope

Add one time formatter that follows the decision above, and use it in components/thread/task-thread.tsx, components/task/thread-runs.tsx, components/task/task-page.tsx, components/requests/request-card-logic.ts, components/task/files-logic.ts, components/task/action-log.tsx, the desk pane and the card status line.

## Check

Unit tests for the formatter. Browser: send a chat message and read its time, the desk pane's time and the card's status line, all the same hour.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the RH walkthrough.
- 2026-11-21: dispatched on task/RH.9-one-time-zone-rule-for-what-the-app-prin (v4 controller session).
- 2026-11-21: merge conflict with main in agent-card.tsx and roster.ts (DR.15/FR.2 landed). Sent back to merge main.
- 2026-11-21: merged main, conflict resolution reviewed clean. Ready at 1268e407.
- 2026-11-21: merged c09ebdb0, merge check passed. Done.
