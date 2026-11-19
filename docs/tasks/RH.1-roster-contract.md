---
id: RH.1
title: "Roster contract: avatar column, card types, router"
milestone: RH
size: S
status: todo
depends_on: []
branch: null
lane: contract
executor: claude
---

From `docs/v4/build-plan.md`, milestone RH. Contract task for RH. It alone changes `packages/db/src/schema`, generates migrations, edits `packages/db/src/shared.ts`, wires the new service in `apps/web/src/server/compose.ts` and mounts the new tRPC router in `apps/web/src/server/trpc/router.ts`. Every procedure exists after this task with its final input and output types and a stub body, so the service, MCP and web tasks of RH run in parallel against it.

## Scope

- `agents.avatar` (text, JSON `{ color, glyph }`, default derived from the name). Generate the migration and backfill existing agents.
- In `@repo/db/shared`: `AGENT_CARD_STATES = ["needs_you", "stopped", "working", "idle"]` and the `AgentCard` type: id, name, slug, avatar, job line, owner name, state, status line, needsYouCount, costThisWeekCents, weeklyCapCents (null), learnedCount (0), teamId (null), isLead (false).
- `@repo/services/roster` with `list(principal)` returning `AgentCard[]` (stub returns agents with state `idle`). Wire in `compose.ts`, mount `roster` in the tRPC root.

## Check

- Migration applies locally and on a copy of staging data.
- `router.test.ts` knows the new router.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
