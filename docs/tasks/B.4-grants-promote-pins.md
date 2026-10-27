---
id: B.4
title: Grants, propose and promote, pins and hand-to
milestone: B
size: L
status: in_progress
depends_on: [A.1, B.1]
branch: task/B.4-grants-promote-pins
lane: services-grants
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

## Moved up (2026-10-27)
Dom asked to move phase 2 work up, so this runs beside A.2 instead of after it. Where this differs from the scope above, it wins.
- Put the logic in new files, `packages/services/src/artifacts/grants.ts` and `pins.ts` (own `exports` entries), with their own query functions in `packages/db/src/artifact-grants.ts`. Don't edit A.2's `service.ts`; promote updates `current_version_id` and version `status` through your own queries inside `atomic`. Parsing `harbourmaster.json` takes the version's file list and text as input, so A.2's create and update can call it later.
- In `artifacts-router.ts` touch only the phase 2 stub procedures (promote, decideGrant, pin, unpin, handTo). A.2 fills the others in parallel; on `git merge v3/artifacts`, resolve conflicts keeping both.
- The MCP part (`artifact_promote`, `kind: "app"`) moves to B.8, because A.5 owns the MCP file now.

## Log
- 2026-10-27: planned (controller).
- 2026-10-27: dispatched.
