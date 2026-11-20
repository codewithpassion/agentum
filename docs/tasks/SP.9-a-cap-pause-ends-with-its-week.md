---
id: SP.9
title: "A cap pause ends with its week"
milestone: SP
size: S
status: done
depends_on: [SP.5]
branch: task/SP.9-a-cap-pause-ends-with-its-week
lane: worker
executor: claude
---

From the spend walkthrough (`docs/reviews/SP-e2e.md`, finding 5). A pause for hitting the weekly cap stays after the week rolls over, until someone presses Resume.

## Decision

Controller decision (Dom's "don't wait for me", 21 Nov 2026): yes. The cap is weekly, so a cap pause lifts when the new week starts and the agent is under its caps. A manual pause stays.

## Scope

The minute tick clears `spend_cap` pauses when the agent's and the workspace's week-to-date are under their caps. The Needs you card is derived from the pause, so it goes too. A `manual` pause stays.

## Check

A service test with the clock set across Monday 00:00 in the workspace timezone: paused on Sunday, resumed by the tick on Monday. A `manual` pause is untouched. An agent whose cap is still below its week-to-date is not resumed.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-21: added from the spend walkthrough.
- 2026-11-21: dispatched.
- 2026-11-21: review clean with no fix rounds. The last commit (wording) wasn't reviewed, so it goes back for a fresh review of that commit.
- 2026-11-21: wording commit reviewed clean (two nits left: stale pausedAt comment in the schema, and help text that doesn't say raising a cap lifts the pause). Ready at 9038a8f8. Queued for merge.
- 2026-11-21: merged 108f50cb, batch merge check with FX.3, SP.10 and SP.9 passed. Done.
