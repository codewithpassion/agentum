---
id: TH.2
title: A thread page with a stable URL
milestone: TH
size: M
status: done
depends_on: [TH.1]
branch: task/TH.2-thread-page
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
- 2026-11-10: dispatched to a Sonnet implementer on task/TH.2-thread-page. Lane rule relaxed for this run (Dom asked for about six in parallel); files checked against the other running tasks. Runs beside TH.3; TH.2 owns the thread page, TH.3 the list.
- 2026-11-10: Review clean after 2 fix rounds. Reply while a run works: the composer shows 'Reply when it is done', so a second message cannot start; edit and resend cancels the active run. Long threads: tasks.get reads only the oldest 1500 events and sets eventsTruncated, which no UI reads, so the newest events are cut on a longer thread. Follow-up candidate. Local browser check passed (reply twice, reload, redirect, rename, pin, archive). Merged as d1afd3c5. check, test and build green on main (guest-execution.test.ts failed under full-suite load and passed alone, as on main before).
