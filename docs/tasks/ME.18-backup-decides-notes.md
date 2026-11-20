---
id: ME.18
title: "The backup owner decides held notes and dream questions"
milestone: ME
size: S
status: done
depends_on: [ME.17]
branch: task/ME.18-backup-decides-notes
lane: services-rail
executor: claude
---

From the ME.17 review (`docs/reviews/tasks/ME.17.md`). After ME.17 the memory service refuses non-owners, but the Needs you cards for a held note and a dream question still reach non-owners and the backup, so those cards are a dead end.

## Decision

Controller decision (20 Nov 2026): an agent's backup owner counts as an owner for deciding its held notes and dream questions, because the backup stands in when the owner is away. Workspace admins can decide too. Nobody else sees these cards.

## Scope

- The memory and dream services accept a decision from the agent's owners, its backup and workspace admins.
- `desk.ts` rail sources show held-note and dream-question cards only to those people, keeping the rail's owner-then-backup escalation.

## Check

- Service tests: owner, backup and admin can decide; a plain member is refused.
- Rail tests: a plain member gets no held-note or dream-question card; the backup gets it after the escalation delay, as today.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the ME.17 review.
- 2026-11-20: dispatched on task/ME.18-backup-decides-notes (v4 controller session).
- 2026-11-21: merged as ed36c81f, review clean after 0 fix rounds. check, test and build passed on main. The held dream batch rule became DR.14.
