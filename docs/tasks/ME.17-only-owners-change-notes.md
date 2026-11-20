---
id: ME.17
title: "Only an agent's owners or an admin change its notes"
milestone: ME
size: S
status: in_progress
depends_on: []
branch: task/ME.17-only-owners-change-notes
lane: web-knows
executor: claude
---

From the DR.8 browser proof (`docs/reviews/tasks/DR.8/browser.md`). A plain member sees Undo buttons under "Learned this week" on another person's agent. Changing an agent's memory follows the same rule as its keys (Dom's KY rule: owners and admins).

## Scope

- The memory service refuses undo, edit, delete and decide on an agent's shared notes from anyone who isn't an owner of the agent or a workspace admin. A person's own private notes stay theirs to change.
- The Knows tab hides or disables those controls for everyone else, with the same note the Keys tab uses.

## Check

- Service tests for owner, admin and plain member on undo, edit, delete and decide. A refused call leaves the notes unchanged. A member can still change their own private note.
- Browser as the plain member dev user: no Undo or edit controls on another person's agent's Knows tab; as the owner they work.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the DR.8 browser proof. Rule follows Dom's KY decision.
- 2026-11-20: dispatched on task/ME.17-only-owners-change-notes (v4 controller session).
