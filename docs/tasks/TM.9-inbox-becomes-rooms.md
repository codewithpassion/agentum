---
id: TM.9
title: "Inbox becomes rooms in the shell"
milestone: TM
size: S
status: in_progress
depends_on: [TM.7, RH.6]
branch: task/TM.9-inbox-becomes-rooms
lane: web-shell
executor: claude
---

From `docs/v4/build-plan.md`, milestone TM. The forum inbox page is replaced by team rooms.

## Scope

- `/inbox` redirects to the Everyone team's room, and `/inbox?thread=<id>` to that topic.
- Find lists each team room and drops "Threads". The `inbox_reply` Needs you item opens the topic in its room.
- Remove `routes/_app/inbox.tsx` content and unused `components/inbox/*` files once nothing imports them.

## Check

- `find-registry.test.ts` passes. Browser: an old inbox link lands on the right topic.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-21: dispatched on task/TM.9-inbox-becomes-rooms (v4 controller session).
- 2026-11-21: ready at a9d0a286 after fix round (review clean, 404 gone, browser re-verified). Queued for merge.
- 2026-11-21: merge conflict with main in inbox.ts and inbox-router.ts (TX.3 landed). Sent back to merge main.
