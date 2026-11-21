# TX.10 review: Team memory on the team page

Verdict, round 1 (0608c9ea): clean. No must-fix. No fix rounds.

## What shipped

- `dream.listTeam` (service and tRPC) lists a team's dreams, newest first. Team notes use the existing `memory.listTeam`.
- A "Team memory" section on the team page, for the owner or an admin of a team that has a library folder: Dream now, the latest team dream's diary and counts, Undo this night, and the team's shared notes grouped by kind (read only).
- The agent `DreamCard` is reused with its schedule picker made optional. `useDream` and the new `useTeamDream` share one core.

## Nits left

- `use-team-memory.ts`: `nowMs` refreshes only when notes are re-read.
- `use-dream.ts`: a team Dream now or Undo does not fire `RAIL_REFRESH_EVENT` (an agent Dream now behaves the same).
- `team-memory.tsx`: `key={error}` repeats if both errors are the same string. Two no-ops (`onDecide`, `decideNothing`) for the same case.
- No test of the hook wiring (`useTeamDream`, `useTeamMemory`). The agent hook has none either.
- A team with no folder shows no Team memory section and no hint why.

## Ideas beyond the scope

- List earlier team dreams (`EarlierDreams` can take the same runs).
- Show the room digest beside the notes.

## Steps for Dom

None.

## Skipped browser steps

The task's check ends with "the browser at both sizes". Skipped, as the brief says: Team memory section on a team page as owner (Dream now, Undo, notes) at desktop and phone widths. Runs in the one pass after all tasks merge.
