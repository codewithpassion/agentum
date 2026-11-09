---
id: TH.2
title: A thread page with a stable URL
milestone: TH
size: M
status: todo
depends_on: [TH.1]
branch: null
lane: web
executor: claude
---

From the 10 Nov 2026 review. The URL names a run today, and each reply navigates to a new `/tasks/<runId>` (`apps/web/src/components/task/task-thread.tsx`).

## Scope

- `/threads/$sessionId` shows the whole thread with the composer. `?run=` scrolls to one run, and the open tab is in the URL.
- `/tasks/$runId` redirects to its thread. A reply stays on the same URL.
- Title shown and editable in the header, with pin and archive.
- Register the page in `rail/find-registry.ts`.
- Check and note in the log what happens when a person replies while a run works, and how a long thread loads.

## Check

- Route and component tests, `find-registry.test.ts` passes.
- On staging: open a thread, reply twice, reload, and the URL holds.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
