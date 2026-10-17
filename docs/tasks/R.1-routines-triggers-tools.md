---
id: R.1
title: MCP tools to manage routines and triggers, approve-first for agents
milestone: R
size: M
status: in_progress
depends_on: [M2.3]
branch: task/R.1-routines-triggers-tools
---

Asked for by Dom on 17 Oct 2026. Routines (schedules, `packages/services/src/routines.ts`) and triggers (`packages/services/src/triggers.ts`) are made only in the web UI today. The Harbourmaster MCP server (`packages/mcp/src/tools/`, ports in `apps/web/src/server/mcp/ports.ts`) has no tools for them. Two callers reach `/mcp`: a person's OAuth client or API key (a user principal, such as Claude.ai), and an agent's run (a run principal).

## Scope

1. MCP tools `list_routines`, `create_routine`, `set_routine_enabled`, `delete_routine`, `list_triggers`, `create_trigger`, `set_trigger_enabled` and `delete_trigger`. Inputs mirror what the UI's tRPC procedures take, and the tools call the same service methods, so validation and `authorize()` stay in the services. Tool descriptions say what each does in plain words and give a cron example for routines.
2. User principal: acts as the person, with the same rules as the UI. A connected app with read-only access (the `access` on its `oauth_clients` row) gets the list tools only.
3. Run principal: may list, create, enable and delete only for its own agent. Whatever it creates is stored disabled and marked as proposed by that agent (agent id and run id). A run can never enable one, its own proposals included. It may delete only routines and triggers it proposed. The tool result says the proposal waits for approval in the UI. When a trigger has a secret or a signed URL, the run never gets it back; only the UI shows it.
4. UI: the Routines and Triggers pages mark proposed items ("Proposed by <agent>") with an Approve action that enables them, and a Reject action that deletes them. Approval needs the same rights as creating one in the UI.
5. Log: creation, approval, rejection and deletion each write an event, naming the principal.
6. A schema change goes through `bun run generate` in `packages/db`, with `migrations/` committed.

## Check

- Service and tool tests: a user creates an enabled routine and trigger; a read-only client sees only the list tools; a run creates a routine for its own agent and it is stored disabled and proposed; a run cannot create one for another agent, enable anything, or delete one it didn't propose; a run's trigger result carries no secret; approve enables and reject deletes; events are written.
- Browser, with dev login on a local dev server: a proposed routine shows "Proposed by" with Approve, and approving enables it.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-17: added at Dom's request (both: MCP for people, approve-first for agents); dispatched on task/R.1-routines-triggers-tools.
