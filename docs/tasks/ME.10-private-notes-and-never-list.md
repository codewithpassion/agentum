---
id: ME.10
title: "Private notes stay private, and the never list holds on write"
milestone: ME
size: M
status: done
depends_on: [ME.3, ME.5]
branch: task/ME.10-private-notes-and-never-list
lane: services-memory
executor: claude
---

From the ME.5 review (`docs/reviews/tasks/ME.5.md`). Two gaps against the ME decisions ("private notes stay with that person", Remember and Never lists):

1. A run's library scope covers the agent's whole home folder, including `memory/private/*.md` for every person. Any run can read or sync another person's private notes through the library tools or the sync helper.
2. Nothing enforces the Never list when a note is written (the memory service from ME.3 and the `remember` tool from ME.4). The prompt is the only guard.

## Scope

- Runs see only their own person's private notes. `librarySyncScope` and the library read, list and search paths leave out `memory/private/` except the file for the person the run acts for. Runs with no person (routines, triggers) see no private notes.
- The memory service refuses a note that matches the agent's Never list, with a clear error the `remember` tool passes back to the agent. The refusal is recorded like other memory changes.
- Tests for both: a run for person A cannot list, read or sync person B's private note; a run for A can read A's; a routine run sees none; a note matching the Never list is refused through the service and through the tool.

## Check

- The tests above pass.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the ME.5 review.
- 2026-11-20: dispatched on task/ME.10-private-notes-and-never-list (v4 controller session).
- 2026-11-20: merged as 2ec22717, review clean after 0 fix rounds. check and build passed on main; tests passed except the two known flakes in FX.1 (services never-claimed-runs timing test, guest-execution). Private notes were already hidden from runs since ME.3; this task pinned that with tests and added the never-list refusal.
