---
id: TM.8
title: "Home: cards grouped by team"
milestone: TM
size: S
status: in_progress
depends_on: [TM.1, RH.3]
branch: task/TM.8-home-team-groups
lane: web-home
executor: claude
---

From `docs/v4/build-plan.md`, milestone TM. Mockup: the home screen of Proposal A.

## Scope

- Group cards by home team with a heading (team name, lead, counts) and an "Open room" button. Agents in no team come last under "No team".
- A lead badge on the lead's card. A team group collapses and remembers its state per person in local storage.
- "Add to team" on the dashed card opens the member picker from the team page.

## Check

- Component tests for grouping and collapse. Browser check with two teams.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/TM.8-home-team-groups (v4 controller session).
