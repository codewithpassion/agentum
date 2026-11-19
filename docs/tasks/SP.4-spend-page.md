---
id: SP.4
title: "Spend page, cap field and card line"
milestone: SP
size: M
status: todo
depends_on: [SP.1, RH.4, RH.6]
branch: null
lane: web-spend
executor: claude
---

From `docs/v4/build-plan.md`, milestone SP. Give the workspace one place to see cost.

## Scope

- New route `/spend`: this week and last four weeks per agent as a table with one bar chart. Load the `dataviz` skill before building the chart.
- Cap field on the agent's Settings tab and a workspace cap in Settings. "$4.10 of $20 this week" in the agent header and on the card when a cap is set.
- The `spend_pause` item renders in the Needs you pane with Resume and Raise the limit.
- Show the Spend link in the top bar. Add the page to `find-registry.ts`.

## Check

- Component tests for the table and the pause card.
- Browser: set a low cap, run a task with the fake runtime until it pauses, resume.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
