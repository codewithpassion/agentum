---
id: KY.1
title: "Keys contract: catalogue key, read model types, router"
milestone: KY
size: S
status: todo
depends_on: []
branch: null
lane: contract
executor: claude
---

From `docs/v4/build-plan.md`, milestone KY. Contract task for KY. It alone changes `packages/db/src/schema`, generates migrations, edits `packages/db/src/shared.ts`, wires the new service in `apps/web/src/server/compose.ts` and mounts the new tRPC router in `apps/web/src/server/trpc/router.ts`. Every procedure exists after this task with its final input and output types and a stub body, so the service, MCP and web tasks of KY run in parallel against it.

## Scope

- `connectors.catalog_key` (text, nullable). Migration.
- In `@repo/db/shared`: `AgentKeys` type with five parts: apps (connector, credential mode, whose sign-in, allowed tools), identity (email address, Slack app state), secrets (name, kind), otherAgents (A2A connections and hands-to), asksBefore (level and overrides). `CatalogEntry` type: key, name, description, icon, url, auth kind, default allowed tools.
- `@repo/services/keys` with `forAgent(principal, agentId)`, and `@repo/services/catalog` with `list()` and `add(principal, key)`. Stubs. Wire and mount `keys` and `catalog`.

## Check

- Migration applies. `router.test.ts` knows both routers.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
