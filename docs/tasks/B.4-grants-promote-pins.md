---
id: B.4
title: Grants, propose and promote, pins and hand-to
milestone: B
size: L
status: todo
depends_on: [A.2, A.5, B.1]
branch: null
lane: services
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD), phase 2, and `docs/v3/phase2-spike.md` (B.1's findings, which win where they differ). A.1 holds every schema change; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations. Integration branch: `v3/artifacts`.

## Scope
- In the artifacts service (A.2's files): `app` kind versions with `server/`; parse and validate `harbourmaster.json` (connector and platform read tools with argument limits, hosts, vault secret names); write `artifact_grants` rows per version. Agent `app` versions start `proposed`; `artifact_promote` makes one current when it adds no grants, secrets or hosts beyond the current version's approved set, otherwise it creates a request in Needs you through the existing requests service and waits (R2.4). Only `readOnlyHint` tools can be granted. `decideGrant` approves or rejects, writing `artifact.grant_decided`. Promote writes `artifact.promoted`. Pages, docs and dashboards stay publish-at-once.
- Pins (R2.7): pin, unpin, list for a user, surfaces `sidebar` and `desk`, on `artifact_pins`.
- Hand-to (R2.9): owner or admin sets `handed_to_agent_id`; that agent may then update (policy already allows it); event `artifact.handed_to`.
- Fill `promote`, `decideGrant`, `pin`, `unpin`, `handTo` in `artifacts-router.ts`.
- MCP: `artifact_promote` in `packages/mcp/src/tools/artifacts.ts`, `kind: "app"` accepted by create and update, dry-run text, `PLATFORM_TOOL_LABELS` entry.

## Check
- Tests for R2.4, R2.7, R2.9, the grant validation (non-read-only tool refused), the Needs you request and the promote after approval.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: planned (controller).
