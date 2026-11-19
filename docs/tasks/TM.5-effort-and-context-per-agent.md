---
id: TM.5
title: "Thinking level and context size per agent"
milestone: TM
size: M
status: todo
depends_on: [TM.1]
branch: null
lane: runtimes
executor: claude
---

From `docs/v4/build-plan.md`, milestone TM. From the IndyDevDan transcript and the 18 Nov analysis: run a lead high and workers lower.

## Scope

- Read `runtimeConfig.effort` and `contextBudget` where each runtime builds its model call: the cloud run (`packages/services/src/cloud/runtime.ts`), Managed Agents (`packages/services/src/managed`), and the machine claim (`runs/machine-claim.ts`) which passes them to the `agentum` client.
- `apps/agentum`: pass the effort to Claude Code's flag for it. Unknown values fall back to the default.
- Map the three context sizes to compaction thresholds in one table in `@repo/db/shared`.
- Subagents keep their own setting from `docs/v3/subagents.md`.

## Check

- Tests per runtime that the values reach the call. `cargo test` for the client.
- An agent with no setting behaves as before.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
