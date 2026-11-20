---
id: SP.1
title: "Spend contract: caps, pause, router"
milestone: SP
size: S
status: done
depends_on: []
branch: task/SP.1-spend-contract
lane: contract
executor: claude
---

From `docs/v4/build-plan.md`, milestone SP. Contract task for SP. It alone changes `packages/db/src/schema`, generates migrations, edits `packages/db/src/shared.ts`, wires the new service in `apps/web/src/server/compose.ts` and mounts the new tRPC router in `apps/web/src/server/trpc/router.ts`. Every procedure exists after this task with its final input and output types and a stub body, so the service, MCP and web tasks of SP run in parallel against it.

## Scope

- `agents.weekly_cap_cents` (integer, null for none), `agents.paused_at`, `agents.paused_reason` (`spend_cap`, `manual`). `workspaces.weekly_cap_cents` (null for none).
- `@repo/db/shared`: `SpendRow` (agent, day, cents, tasks), `SPEND_PAUSE_REASONS`. Add `spend_pause` to `NEEDS_YOU_KINDS`.
- `@repo/services/spend` with `workspace(principal, range)`, `byAgent(principal, agentId, range)`, `setCap`, `resume`. Stubs. Wire and mount `spend`.

## Check

- Migration applies. `router.test.ts` knows the router.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/SP.1-spend-contract (v4 controller session).
- 2026-11-20: merged as f8d13d73, review clean after 2 fix rounds. check and build passed on main. The full test run failed on room.test.ts and guest-execution.test.ts (live artifacts, workerd); run alone on the merged tree both passed, and guest-execution failed alone on the pre-merge commit. Dom: apply migration 0056 to staging and production.
