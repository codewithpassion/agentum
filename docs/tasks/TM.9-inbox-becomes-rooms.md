---
id: TM.9
title: "Inbox becomes rooms in the shell"
milestone: TM
size: S
status: todo
depends_on: [TM.7, RH.6]
branch: null
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
