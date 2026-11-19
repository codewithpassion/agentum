---
id: SP.2
title: "Spend rollups from run usage"
milestone: SP
size: M
status: todo
depends_on: [SP.1]
branch: null
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
