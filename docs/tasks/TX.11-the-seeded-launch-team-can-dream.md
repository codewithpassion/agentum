---
id: TX.11
title: "The seeded Launch team can dream"
milestone: TX
size: S
status: done
depends_on: []
branch: null
lane: scripts-dev
executor: claude
---

From the team extras walkthrough (`docs/reviews/TX-e2e.md`).

Finding. `scripts/dev/seed-slack-room.ts` writes the team rows directly and sets no `folder_path`, so `runTeamNow` answers "Launch has no team folder, so it keeps no team memory and does not dream". A team made in the UI gets `teams/<slug>` and works. The walkthrough made a second team ("Crew") in the UI for the dream.

Scope. Make the seed create the team through `teams.create` (or write the folder and its grants).

Check. A seed test that `runTeamNow` on the seeded team does not refuse.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-21: added by controller from the TX walkthrough.
- 2026-11-21: deferred to the backlog on Dom's scope freeze (only must-fix bugs stay in v4).
- 2026-11-22: back in scope on Dom's call (all deferred tasks except the flaky-test fixes).
- 2026-11-22: dispatched.
- 2026-11-22: merged at c4071762, review clean after 1 fix round.
