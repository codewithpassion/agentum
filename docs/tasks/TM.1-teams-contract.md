---
id: TM.1
title: "Teams contract: teams, members, topics, profiles, router"
milestone: TM
size: M
status: done
depends_on: []
branch: task/TM.1-teams-contract
lane: contract
executor: claude
---

From `docs/v4/build-plan.md`, milestone TM. Contract task for TM. It alone changes `packages/db/src/schema`, generates migrations, edits `packages/db/src/shared.ts`, wires the new service in `apps/web/src/server/compose.ts` and mounts the new tRPC router in `apps/web/src/server/trpc/router.ts`. Every procedure exists after this task with its final input and output types and a stub body, so the service, MCP and web tasks of TM run in parallel against it. A team room is the existing forum inbox scoped to a team. A topic is an `inbox_threads` row.

## Scope

- Tables: `teams` (id, workspace_id, name, slug, lead_agent_id, owner_user_id, rules text, lead_listens boolean default true, folder_path, created_at, archived_at), `team_members` (team_id, member_kind `agent` or `user`, member_id, is_home boolean), `member_profiles` (workspace_id, user_id, name, handle unique per workspace).
- `inbox_threads` gains `team_id` (nullable, indexed) and `opened_by_agent_id`. New `inbox_thread_members` (thread_id, member_kind, member_id) for a topic limited to some members.
- Backfill: one team "Everyone" per workspace with no lead, and every existing inbox thread gets its id.
- `runtimeConfig` zod schema (`packages/services/src/runs/types.ts` or where it is defined): optional `effort` (`low`, `medium`, `high`) and `contextBudget` (`small`, `standard`, `large`). No migration, it is JSON.
- `@repo/db/shared`: `Team`, `TeamMember`, `TEAM_MEMBER_KINDS`, `EFFORT_LEVELS`, `CONTEXT_BUDGETS`. `AgentCard.teamId` and `isLead` become real.
- `@repo/services/teams` with `list`, `get`, `create`, `update`, `archive`, `addMember`, `removeMember`, `setLead`, `setRules`, and `profiles.get/set`. Stubs. Wire and mount `teams`.

## Check

- Migration and backfill apply on a copy of staging data, and every old thread still opens.
- `router.test.ts` knows the router.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/TM.1-teams-contract (v4 controller session).
- 2026-11-20: merged as 29e2f89f, review clean after 1 fix round. check and build passed on main; tests passed except guest-execution.test.ts, which fails the same way on main before this merge (FX.1). Still open: apply 0057 to a copy of staging D1 and confirm no thread has a NULL team_id and each workspace has one Everyone team, before the next remote migration.
