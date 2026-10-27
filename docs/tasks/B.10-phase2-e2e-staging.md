---
id: B.10
title: Phase 2 end-to-end and staging check
milestone: B
size: M
status: todo
depends_on: [A.11, B.7, B.8, B.9]
branch: null
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

## Log
- 2026-10-27: planned (controller).
