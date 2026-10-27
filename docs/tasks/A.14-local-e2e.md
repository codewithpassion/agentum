---
id: A.14
title: Phase 1 local end-to-end check and fixes
milestone: A
size: M
status: in_progress
depends_on: [A.6, A.7, A.8, A.9, A.10, A.13]
branch: task/A.14-local-e2e
lane: e2e
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD). A.1 holds every schema change, shared constant, protocol schema and seam; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations, and works against A.1's types. Integration branch: `v3/artifacts`.

## Scope
- On a local dev server with dev login, run the whole phase 1 flow and fix what breaks (small fixes in any file; anything bigger, report blocked with the reason):
  1. A cloud-isolate agent in web chat makes a `page`, a `doc` and a `dashboard` (with `data.json`) through the MCP tools, tests them with `artifact_test`, and the card shows in the thread live and after reload.
  2. The task view slot, `/artifacts`, `/a/<id>` with version picker, history and restore, rename, delete, audience switch.
  3. Share dialog: create links (expiry, pinned), open in a fresh browser profile with no session, see the share frame labels; revoke, reopen gives the dead-link page; the links switch off gives the same; the access log shows the rows.
  4. The R1.19 probe artifact framed and opened directly, in Chromium and Firefox.
  5. Every UI piece at 390 x 844 (R1.26).
- Every browser check the UI tasks deferred.
- Record evidence per R1 requirement in `docs/reviews/tasks/A.14.md`.

## Check
- Each step above passes, with the evidence line in the review file.
- `bun run check && bun run test && bun run build` pass.

## Notes (2026-10-27)
- `apps/web/.env.local` in the v3 worktree now has `ARTIFACT_VIEW_KEY`; copy it from there. Local Browser Run needs `CI=1` on `vite dev`.
- Deferred browser checks you own: A.8 (R1.25, R1.26, R1.28), A.9 (R1.23, R1.24), A.10 (R1.27, R1.29, R1.31 display), A.13 (R1.22).
- This is the demo path for Dom tonight. Fix what blocks it first, then work through the full list.

## Log
- 2026-10-27: planned (controller).
- 2026-10-27: dispatched.
