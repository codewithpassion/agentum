---
id: B.5
title: Member live tool calls and storage procedures
milestone: B
size: M
status: todo
depends_on: [A.2, A.3, B.3, B.4]
branch: null
lane: services-calls
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD), phase 2, and `docs/v3/phase2-spike.md` (B.1's findings, which win where they differ). A.1 holds every schema change; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations. Integration branch: `v3/artifacts`.

## Scope
- `packages/services/src/artifacts/calls.ts`: `callTool(principal, { artifactId, versionId, tool, arguments })` for a signed-in member: the tool must be in the version's approved grants and `readOnlyHint`; run it through the existing credentials path with the viewer's own credential (`credentials.resolve`, `packages/services/src/credentials.ts`); scrub with `events/scrub.ts`; cap the size (R2.5). The same function with a `ShareGrant` for live links is B.6's; design the internals so B.6 adds that entry without reshaping this one.
- tRPC: fill `callTool` in `artifacts-router.ts`, and storage procedures (get, set, delete, list) for the bridge that go to B.3's store through its port, as the signed-in viewer.
- A port the B.2 `AppHost` uses for granted tool calls from app server code.

## Check
- Tests for R2.5: a granted tool runs with the viewer's credential, an ungranted one and a non-read-only one are refused, results are scrubbed and capped.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: planned (controller).
