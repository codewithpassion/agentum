---
id: JB.1
title: "Jobs contract: sentence types and router"
milestone: JB
size: S
status: in_progress
depends_on: []
branch: task/JB.1-jobs-contract
lane: contract
executor: claude
---

From `docs/v4/build-plan.md`, milestone JB. Contract task for JB. It alone changes `packages/db/src/schema`, generates migrations, edits `packages/db/src/shared.ts`, wires the new service in `apps/web/src/server/compose.ts` and mounts the new tRPC router in `apps/web/src/server/trpc/router.ts`. Every procedure exists after this task with its final input and output types and a stub body, so the service, MCP and web tasks of JB run in parallel against it. JB needs no schema change. `workspaces.timezone` already exists.

## Scope

- In `@repo/db/shared`: `JobSentence` type: id, agent, source (`routine`, `http`, `mail`, `app`, `slack`), when (text), does (text), asksBefore (text or null), deliversTo (text or null), enabled, lastRunAt, lastRunOk, nextRunAt.
- `@repo/services/jobs` with `forAgent`, `list`, `draft(principal, agentId, text)` returning a proposed trigger, and `runNow(principal, jobId)`. Stubs. Wire and mount `jobs`.
- `workspaces.setTimezone` procedure in the existing `workspaces-router.ts`, admin only.

## Check

- `router.test.ts` knows the router. A test covers `setTimezone` authz.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/JB.1-jobs-contract (v4 controller session).
