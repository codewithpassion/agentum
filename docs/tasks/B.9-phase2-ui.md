---
id: B.9
title: "Phase 2 UI, live links, grant approvals, pins, hand-to"
milestone: B
size: M
status: todo
depends_on: [A.8, A.10, B.4, B.6]
branch: null
lane: web-share
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD), phase 2, and `docs/v3/phase2-spike.md` (B.1's findings, which win where they differ). A.1 holds every schema change; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations. Integration branch: `v3/artifacts`.

## Scope
- Share dialog (A.10's file): data choice "Snapshot only" (preselected) or "Live, using my connections", tool checkboxes with none ticked, the warning text from PRD section 8, owner only; "Live as <owner>" badge in the link list (R2.15).
- Grant approval card in Needs you for a proposed app version (tools, hosts, secrets listed; approve or reject through `decideGrant`).
- Viewer: version status `proposed` shown, Promote for the owner when allowed.
- Pins (R2.7): pin from the viewer menu to the sidebar and to the desk; pinned artifacts listed in the sidebar and as a desk tile.
- Hand to another agent from the viewer menu (R2.9).

## Check
- Component tests for the live choice defaults and warning, the approval card and pin toggles.
- Browser check of each item when B.4 and B.6 are merged; otherwise in B.10.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: planned (controller).
