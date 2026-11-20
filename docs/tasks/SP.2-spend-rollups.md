---
id: SP.2
title: "Spend rollups from run usage"
milestone: SP
size: M
status: done
depends_on: [SP.1]
branch: task/SP.2-spend-rollups
lane: services-spend
executor: codex
---

From `docs/v4/build-plan.md`, milestone SP. Cost shows per run and per agent week only. Roll it up for the workspace.

## Scope

- Fill `spend.workspace` and `spend.byAgent` from `runs.usage`, grouped by agent and day in the workspace timezone. Include dream usage from `dream_runs.usage` when that table exists, behind a query that tolerates it being empty.
- `weekToDate(agentId)` and `wouldExceed(agentId)` helpers for the cap check.
- Reuse the price logic that `agents-table-logic.ts` relies on. One source of prices.

## Check

- Tests: grouping across a timezone day boundary, an agent with no runs, week start on Monday.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: from the DR.1 review: spend rollups also count `dream_runs.usage`.
- 2026-11-20: dispatched on task/SP.2-spend-rollups (v4 controller session).
- 2026-11-20: merged as 16ea48db, review clean after 1 fix round. check, test and build passed on main. Counts dream usage.
