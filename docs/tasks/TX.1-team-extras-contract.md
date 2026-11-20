---
id: TX.1
title: "Team extras contract: team memory, discussions, decision queue"
milestone: TX
size: S
status: in_progress
depends_on: [TM.1, DR.1]
branch: task/TX.1-team-extras-contract
lane: contract
executor: claude
---

From `docs/v4/build-plan.md`, milestone TX. Contract task for TX. It alone changes `packages/db/src/schema`, generates migrations, edits `packages/db/src/shared.ts`, wires the new service in `apps/web/src/server/compose.ts` and mounts the new tRPC router in `apps/web/src/server/trpc/router.ts`. Every procedure exists after this task with its final input and output types and a stub body, so the service, MCP and web tasks of TX run in parallel against it.

## Scope

- `memory_changes.team_id` and `dream_runs.team_id` (nullable). A row has an agent or a team.
- Table `discussions`: id, thread_id, started_by_agent_id, rounds, round, status (`running`, `done`, `stopped`), created_at.
- Add `decisions` to `REQUEST_KINDS`. Its `display` holds a list of questions, each with an id, text and options. Its `answer` holds a map of question id to option. Add `decisions` to `NEEDS_YOU_KINDS`.
- Procedures: `memory.listTeam`, `dream.runTeamNow`, `requests.answerDecisions`, `requests.dismissDecisions`. Stubs in the existing routers.

## Check

- Migration applies. Existing request tests pass with the new kind present.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/TX.1-team-extras-contract (v4 controller session).
