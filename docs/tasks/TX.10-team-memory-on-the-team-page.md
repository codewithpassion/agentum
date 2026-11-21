---
id: TX.10
title: "Team memory on the team page"
milestone: TX
size: S
status: todo
depends_on: [TX.11]
branch: null
lane: web-team
executor: claude
---

From the team extras walkthrough (`docs/reviews/TX-e2e.md`).

Finding. A team dream has no button, no card, no list of earlier dreams and no way to read the digest or the team's notes. The only traces are the Needs you question and the Team diary topic. `dream.runTeamNow`, `dream.get` and `dream.undo` exist and work for the owner.

Scope. A service call that lists a team's dreams (`dream.list` takes an agent id only) and reads its team notes, then a "Team memory" section on the team page for the owner: Dream now, the latest team dream's diary and counts, Undo, and the team's notes. Reuse the agent dream card (`components/agent/room/knows/dream/`).

Check. A service test for the list and the notes read, component tests, then the browser at both sizes.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-21: added by controller from the TX walkthrough.
- 2026-11-21: deferred to the backlog on Dom's scope freeze (only must-fix bugs stay in v4).
- 2026-11-22: back in scope on Dom's call (all deferred tasks except the flaky-test fixes).
