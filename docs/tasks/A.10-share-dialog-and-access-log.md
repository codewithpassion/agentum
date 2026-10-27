---
id: A.10
title: Share dialog, access log and links switch
milestone: A
size: M
status: done
depends_on: [A.1]
branch: task/A.10-share-dialog-and-access-log
lane: web-share
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD). A.1 holds every schema change, shared constant, protocol schema and seam; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations, and works against A.1's types. Integration branch: `v3/artifacts`.

UI tasks run beside the backend tasks and code against the A.1 tRPC schemas. If the services and wiring (A.2, A.3, A.6) are already merged into `v3/artifacts` when the units are in, merge `v3/artifacts` and run the browser check against a local dev server (dev login, see CLAUDE.md). If not, the component tests and build are the check, and the browser check moves to A.14; say which in the review file.

## Scope
- Fill `apps/web/src/components/artifacts/share-dialog.tsx` (A.1 stub; PRD section 8 "Share dialog"): dialog on desktop, full-width bottom sheet on phones per MB.1 (`docs/tasks/MB.1-mobile-shell-global.md`); audience switch (Private, Workspace) for owner and admins; the data files in the current version; "Create link" form with expiry (never, 1 day, 7 days, 30 days, a date) and follow-latest or pin-this-version; link list with created by, created, expires, opens, last opened, Copy, Revoke with confirm. Leave a clear place for phase 2's data-mode choice.
- Fill `apps/web/src/components/artifacts/access-log.tsx` (A.1 stub): time, link or member, place, network, browser, outcome, filter by link, stacked rows on phones.
- Settings: an "Artifacts" section with the link-sharing switch, admins only (new `settings.artifacts.tsx` route plus its entry in the settings nav).

## Check
- Component tests for the expiry choices, pin toggle, revoke confirm and the admin-only switch.
- Browser check for R1.27, R1.29 and R1.31's display, including a fresh profile opening a created link (see above for when it runs).
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: planned (controller).
- 2026-10-27: dispatched.
- 2026-10-27: ready at ef55db8, review clean after 1 fix round; browser check moved to A.14; ShareDialog dataFiles prop; merged.
