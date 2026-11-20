---
id: TM.18
title: "A lead listens switch on the team page"
milestone: TM
size: S
status: todo
depends_on: []
branch: null
lane: web-team
executor: claude
---

From the teams walkthrough (`docs/reviews/TM-e2e.md`).

Finding. The team page has no "lead listens" switch, only the sentence "The lead hears room messages that name nobody" under the Lead picker. The setting exists in the service (`lead_listens`) and its tests.

## Scope

First confirm the setting can't be changed from the page. If so, add a switch under the Lead picker that reads and writes `lead_listens` through the existing team update route, for people who may edit the team. Keep the sentence as its description.

## Check

- A component test for the switch.
- Browser at both sizes: turn it off, post a message that names nobody, and the lead doesn't wake.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-21: added by controller.
