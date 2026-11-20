---
id: SP.9
title: "A cap pause ends with its week"
milestone: SP
size: S
status: todo
depends_on: [SP.5]
branch: null
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
