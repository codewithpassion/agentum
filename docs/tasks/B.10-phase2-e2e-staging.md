---
id: B.10
title: Phase 2 end-to-end and staging check
milestone: B
size: M
status: in_progress
depends_on: [A.14, B.7, B.8, B.9]
branch: task/B.10-phase2-e2e-staging
lane: staging
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD), phase 2, and `docs/v3/phase2-spike.md` (B.1's findings, which win where they differ). A.1 holds every schema change; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations. Integration branch: `v3/artifacts`.

## Scope
- Locally, then on staging with the same deploy rules as A.11 (staging only, `bun run staging:deploy`, grep the built config first): an agent builds a "Client intake" app (form, server part storing submissions, list view), tests it, proposes, a person approves its grants and promotes it; a live dashboard calls a connector tool as each member; a snapshot link refuses calls; a live link calls, is rate limited, is revoked and the next call fails; pins on the desk and sidebar; hand-to another agent which then updates it.
- Fix small breakage; report bigger items blocked.
- Record evidence per R2 requirement in `docs/reviews/tasks/B.10.md`.

## Check
- Every R2 requirement has a pass line with evidence, or a line naming what blocks it.

## Refinements (2026-10-27)
- Start the local part now. A.11 (the phase 1 staging deploy) runs in parallel. Don't deploy staging until `docs/tasks/A.11-staging-check.md` in /home/roboto/devel/harbourmaster-wt/v3 says `status: done`, then merge v3/artifacts and deploy once.
- B.8: the `v7` migration adds the `AppStore` Durable Object class, and `APP_API_LIMIT` uses rate-limit namespace ids 2004 to 2006, which wrangler creates on deploy. Platform `harbourmaster/*` tools can't be granted; only connector tools can. Argument limits fail closed.
- B.8 could not reach a connector that answers locally, because the URL check refuses local addresses. On staging, use a real connector the workspace has (Linear or another connector already set up there). If none exists, say so.
- The same refused-command rule as A.11: stop and report blocked with the exact command for Dom.
- Browser checks deferred from B.9 are yours.

## Log
- 2026-10-27: planned (controller).
- 2026-10-27: dispatched (local part first; staging after A.11).
