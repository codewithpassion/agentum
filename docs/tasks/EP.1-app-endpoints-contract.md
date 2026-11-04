---
id: EP.1
title: App endpoints contract and the agentum.json rename
milestone: EP
size: M
status: in_progress
depends_on: []
branch: task/EP.1-app-endpoints-contract
lane: db
executor: codex
---

Spec: `docs/v3/app-endpoints.md`. This is the contract task: it alone changes `packages/db/src/schema` and generates the migration.

## Scope
- Rename `harbourmaster.json` to `agentum.json` and `env.HM` to `env.AGENTUM` everywhere: services, app gateway harness and types, MCP tool descriptions, tests, and the docs `docs/v3/artifacts-prd.md` and `docs/v3/phase2-spike.md`. No fallback for the old names. The TypeScript interface `HM` becomes `AgentumHost`.
- Schema: `ARTIFACT_GRANT_KINDS` gains `endpoint` and `agent`. New table `artifact_endpoints` (id text primary key, artifact_id FK, workspace_id FK, name, created_at, disabled_at nullable), unique on (artifact_id, name) among rows with `disabled_at` null. `triggers.artifact_id` nullable FK. Generate the migration with `migrations/meta`.
- Manifest (`packages/services/src/artifacts/manifest.ts`): `endpoints: [{ name }]` (name `^[a-z0-9-]{1,40}$`, at most 5) and `agents: [{ agent }]` (agent id, at most 5). Both need a `server/` part, and duplicates are refused. Grants are written for both kinds on publish (`grants.ts`).
- `ReplyTarget` (`packages/services/src/runs/types.ts`) gains `{ kind: "app", artifactId, state }` (state at most 4096 characters, default "").
- Types in `apps/web/src/server/app-gateway/types.ts`: viewer kinds `endpoint` ({ endpointId }) and `reply` ({ runId }), `AgentumHost.startRun(input): Promise<{ runId: string }>` and the reply message type from the spec. Stub implementations that throw `not_granted` are fine here. EP.2 and EP.3 fill them.

## Check
- Manifest tests: both new fields parse, are refused without `server/` and refused when duplicated. Grants rows are written for both kinds.
- `schema.test.ts` and `foreign-keys.test.ts` cover the new table and column, and the `events` triggers survive the migration.
- `git grep -n "harbourmaster.json\|env\.HM\b"` returns nothing outside `docs/tasks` and `docs/reviews`.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-04: dispatched.
- 2026-11-04: Dom asked for Codex (gpt-6.1-sol) to implement and Claude to review. Haiku run stopped, its partial rename committed as 34650149, re-dispatched to Codex.
