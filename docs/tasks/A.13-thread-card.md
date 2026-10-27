---
id: A.13
title: Thread card for artifacts
milestone: A
size: M
status: in_progress
depends_on: [A.1]
branch: task/A.13-thread-card
lane: web-thread
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD). A.1 holds every schema change, shared constant, protocol schema and seam; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations, and works against A.1's types. Integration branch: `v3/artifacts`.

UI tasks run beside the backend tasks and code against the A.1 tRPC schemas. If the services and wiring (A.2, A.3, A.6) are already merged into `v3/artifacts` when the units are in, merge `v3/artifacts` and run the browser check against a local dev server (dev login, see CLAUDE.md). If not, the component tests and build are the check, and the browser check moves to A.14; say which in the review file.

## Scope
- `data-artifact` part mapping in `apps/web/src/components/thread/thread-parts.ts` and `assistant-message-container.tsx`, next to `request` and `attachment`, from the `artifact` part A.7's fold emits (`ArtifactThreadPart` from A.1). Keys on the part, never on tool names.
- The card (`apps/web/src/components/artifacts/thread-card.tsx`): title, kind icon, "v<n>", Open; on desktop a lazy-loaded live preview with `ArtifactFrame` at 360 px tall and a click-to-interact overlay; below `MOBILE_BREAKPOINT` the thumbnail and Open. The preview gets its content URL from `artifacts.open` with surface `thread`.

## Check
- Tests for the part mapping and the card's desktop and phone variants.
- Browser check that a run's artifact shows live and after reload (R1.22) (see above for when it runs).
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: planned (controller).
- 2026-10-27: dispatched.
