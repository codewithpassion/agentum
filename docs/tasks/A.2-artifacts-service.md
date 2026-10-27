---
id: A.2
title: Artifacts core service and router
milestone: A
size: L
status: done
depends_on: [A.1]
branch: task/A.2-artifacts-service
lane: services
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD). A.1 holds every schema change, shared constant, protocol schema and seam; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations, and works against A.1's types. Integration branch: `v3/artifacts`.

## Scope
- `packages/services/src/artifacts/service.ts` (own `exports` entry), a factory over `{ db, atomic, blobs, clock, events, library }`, and query functions in `packages/db/src/artifacts.ts` (own entry; not schema). Create, update with the `baseVersion` check (R1.3), content-addressed blob writes at `<ws>/artifact-blobs/<sha256>` and the manifest at `<ws>/artifact-manifests/<versionId>.json` (manifest schema from `@repo/protocol/artifacts`), limits (R1.4), path rules (relative, no `..`, no `_hm/`, entry present), `fromLibraryPath` through the library service's read rules for the run (R1.8), list, get, versions, read one file's text, restore (R1.2), rename, set audience, soft delete, default audience and agent rules through `policy.ts` (R1.5, R1.6, R1.9), the 1 GB workspace quota, and events with `sessionId` and `runId` (`artifact.created`, `artifact.published` with the A.1 payload, `artifact.restored`, `artifact.renamed`, `artifact.audience_changed`, `artifact.deleted`).
- Methods take the calling principal (user or run) and call `authorize()` first. Expose what the MCP tools (A.5) need: create, update, read, list as a run.
- Fill the core procedures in `apps/web/src/server/trpc/artifacts-router.ts` that phase 1 needs: list, get, versions, restore, rename, setAudience, remove. Leave phase 2 procedures (promote, decideGrant, callTool, pin, unpin, handTo) throwing. Don't touch `artifact-shares-router.ts`, `compose.ts` or `server.ts`; A.6 wires the service. Router tests may build the service directly.

## Check
- Unit tests against `bun:sqlite` for R1.2 to R1.6, R1.8, R1.9, the quota, path rules and the events of R1.34 that this service writes.
- Router tests for 401 (no session) and 403/404 (private artifact of another user).
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: planned (controller).
- 2026-10-27: dispatched.
- 2026-10-27: ready at 05ce2a0, review clean after 1 fix round; ServiceError code invalid; url added by A.5/A.6; merged.
