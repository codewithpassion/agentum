# TM.23 review

## Verdicts

Round 1, commit 3c1d167e: must-fix. Switching from one room to another without a reload kept the previous room's polled topic list for up to one poll, because `RoomPage` stayed mounted and `usePolledQuery` ignores a new initial value.

Round 2, commit 037e89bc: clean. The room route keys `RoomPage` by `team.id`, so another team remounts it with its own loader data.

## Notes on the change

- `inbox.listThreads(principal, { teamId? })` filters in SQL before the 50-topic limit. An unknown or foreign-workspace team lists nothing. The Everyone team also lists topics with no team, as `topicsOfTeam` did.
- `topicsOfTeam` and its tests are gone. The room page uses the polled list as is.
- A lead's `inbox_list` in a room run passes the room's team id. Other runs and people list the workspace.
- Browser proof: `docs/reviews/tasks/TM.23/browser.md`, pass at 1280x800 and 390x844.

## Nits left

- `inboxList` in `apps/web/src/server/mcp/ports.ts` calls `teamLead.roomRun` on every call, and `routes/mcp.ts` already makes the same call for the request. The result could be passed into the ports once.
- `inbox-list-port.test.ts` stubs `Services` with `as unknown as`, so a signature change will not fail it at compile time.
- After a Find click the old room stays on screen for about a second while the loader runs, then the new room shows. No stale topics appear.

## Ideas beyond the scope

- None.

## Steps for Dom

- None.
