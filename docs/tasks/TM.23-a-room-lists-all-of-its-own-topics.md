---
id: TM.23
title: "A room lists all of its own topics"
milestone: TM
size: S
status: in_progress
depends_on: [TM.21]
branch: null
lane: services-inbox
executor: claude
---

From the TM gate review, round 1 (`docs/reviews/TM-1.md`, must-fix 5).

## Scope

- `inbox.listThreads` takes an optional `teamId` and filters by it in SQL, before the limit. Without it, it behaves as today for the desk.
- The room page and the room route's loader pass the team's id. `topicsOfTeam` stays only as a guard, or goes.
- The lead's `inbox_list` tool, if it lists topics, passes the run's room team when called from a room run.

## Check

- `inbox.test.ts`: with 60 recent topics in team A and one older topic in team B, listing team B returns its topic.
- `inbox-router.test.ts` covers the new input.
- Browser at desktop size: a team whose only topic is older than 50 others shows it in its room.
- `bun run check && bun run test && bun run build` pass.
## Log
- 2026-11-21: added by controller.
- 2026-11-21: dispatched.
