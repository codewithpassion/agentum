---
id: DR.1
title: "Dream contract: trigger kind, dream runs, router"
milestone: DR
size: S
status: in_progress
depends_on: [ME.1]
branch: task/DR.1-dream-contract
lane: contract
executor: claude
---

From `docs/v4/build-plan.md`, milestone DR. Contract task for DR. It alone changes `packages/db/src/schema`, generates migrations, edits `packages/db/src/shared.ts`, wires the new service in `apps/web/src/server/compose.ts` and mounts the new tRPC router in `apps/web/src/server/trpc/router.ts`. Every procedure exists after this task with its final input and output types and a stub body, so the service, MCP and web tasks of DR run in parallel against it. Dom's decision of 19 Nov: the dream is built into Agentum and never calls The Brain as a service.

## Scope

- Add `dream` to `TRIGGER_KINDS` (not to the kinds a person can create by hand). One dream trigger per agent, created and removed from `agents.remember.dreamSchedule`.
- Table `dream_runs`: id, workspace_id, agent_id, status (`running`, `done`, `skipped`, `failed`, `undone`), started_at, finished_at, since, base_version (library version ids before), result_version, counts (JSON: added, merged, dropped, questions), diary (text), usage (JSON), error.
- `@repo/db/shared`: `DreamRun`, `DreamPlan` (the list of proposed changes a dream produces), `DREAM_MODEL` constant. Add `dream_question` to `NEEDS_YOU_KINDS`.
- `@repo/services/dream` with `runNow(principal, agentId)`, `list(agentId)`, `get(id)`, `undo(principal, id)`. Stubs. Wire and mount `dream`.

## Check

- Migration applies. `router.test.ts` knows the router.
- A test shows `triggers.create` refuses kind `dream` from a person.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/DR.1-dream-contract (v4 controller session).
