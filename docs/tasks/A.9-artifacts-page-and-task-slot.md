---
id: A.9
title: Artifacts page, nav item and task slot
milestone: A
size: M
status: todo
depends_on: [A.1]
branch: null
lane: web-app
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD). A.1 holds every schema change, shared constant, protocol schema and seam; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations, and works against A.1's types. Integration branch: `v3/artifacts`.

UI tasks run beside the backend tasks and code against the A.1 tRPC schemas. If the services and wiring (A.2, A.3, A.6) are already merged into `v3/artifacts` when the units are in, merge `v3/artifacts` and run the browser check against a local dev server (dev login, see CLAUDE.md). If not, the component tests and build are the check, and the browser check moves to A.14; say which in the review file.

## Scope
- "Artifacts" in `mainNavItems` (`apps/web/src/components/shell/nav-registry.ts`), after Library.
- `/artifacts` under `_app` (PRD section 8 "Artifacts page"): grid of cards with thumbnail (`/api/artifacts/:id/thumbnail`) or kind icon, title, owner, author agent, version, updated time, audience badge (Private, Workspace, Link); filters for kind, made by, shared by link; cursor paging; phone layout as single-column rows per MB.2 (`docs/tasks/MB.2-mobile-tables-confirms.md`). Cards link to `/a/<id>` (R1.24).
- Task view: an "Artifacts" slot in the right column (`apps/web/src/components/task/task-page.tsx`, `SlotCard` in `slots.tsx`) listing what the run published, from `artifacts.list` filtered by run (add a `runId` filter to the list input only if A.1's schema lacks it; if so, report it rather than editing protocol) (R1.23).
- Components under `apps/web/src/components/artifacts/list/`.

## Check
- Component tests for the card, filters and the empty state.
- Browser check at 1280 x 800 and 390 x 844 for R1.23, R1.24 (see above for when it runs).
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: planned (controller).
