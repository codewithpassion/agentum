---
id: B.7
title: Bridge phase 2 (tools/call, storage, ui/message)
milestone: B
size: M
status: todo
depends_on: [A.4, A.8, B.5]
branch: null
lane: web-viewer
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD), phase 2, and `docs/v3/phase2-spike.md` (B.1's findings, which win where they differ). A.1 holds every schema change; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations. Integration branch: `v3/artifacts`.

## Scope
- Page side in `_hm/bridge.js` (A.4's file): `tools/call`, storage get/set/delete/list and `ui/message` over the port, exposed on `window.harbourmaster` with promise-returning calls.
- Frame side in `artifact-frame.tsx` (A.8's file): handle them by calling tRPC `artifacts.callTool` and the storage procedures as the signed-in member; for viewer `link`, call `POST /api/share/:token/call` and the link storage read; refuse what the viewer kind can't do with a clear error.
- A sample "live dashboard" fixture under `apps/web/src/server/artifact-content/fixtures/` (or tests) used by the check.

## Check
- Component tests for each message on the member and link paths, including refusals.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: planned (controller).
