---
id: LR.4
title: Deploy live artifacts to staging and run the acceptance checklist
milestone: LR
size: M
status: blocked
depends_on: [LR.1, LR.2, LR.3]
branch: task/LR.4-staging-deploy
lane: ops
executor: claude
---

Item 4 of `docs/reviews/tasks/L.HANDOFF.md`. Dom authorised a staging deploy (28 Oct 2026). Nobody else uses staging. Production is out of scope.

## Scope
- Deploy `main` to staging with `bun run staging:deploy` from `apps/web`, which applies D1 migrations (including `0032_lovely_lake.sql`) and the Durable Object migrations.
- Then run what can be run of the release checklist in `docs/reviews/tasks/L.A.md` against staging; mark items that need Dom's accounts or real third parties as Dom steps.

## Check
- Staging serves the new build; `/` and the guest invite flow respond.
- `docs/reviews/tasks/LR.4.md` lists each checklist item as pass, fail or needs-Dom.

## Log
- 2026-10-28: created from L.HANDOFF.md.
- 2026-10-28: dispatched (Sonnet). Dom authorised the staging deploy.
- 2026-10-28: deployed to staging (version 33171fed), D1 0025-0033 applied. Blocked: Clerk handshake 500 jwk-kid-mismatch, staging Clerk publishable/secret keys from different instances. Checklist 5 pass, 1 fail, 7 needs-Dom.
