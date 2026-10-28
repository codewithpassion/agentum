---
id: LR.7
title: Finish staging acceptance and write the production deploy plan
milestone: LR
size: L
status: in_progress
depends_on: [LR.4, LR.5]
branch: task/LR.7-staging-acceptance
lane: ops
executor: claude
---

Follows LR.4 (`docs/reviews/tasks/LR.4.md`: 6 pass, 7 needs-Dom). Staging uses the Clerk dev instance.

Dom authorised on 28 Oct 2026, staging only:
- Redeploy staging with `bun run staging:deploy` (now includes LR.5).
- Create test users in the Clerk DEV instance: a second member, an admin and guests, and add members to the allowed org.
- Real paid model calls with the Anthropic/OpenRouter keys in `apps/web/.env.local`, kept small.
- Real email (invitations, one-time codes, mention mail) only to Dom's own addresses.
- PDF/Word/PPTX exports through Cloudflare Browser Run.

## Scope
- Run every needs-Dom item in `LR.4.md` (release checklist in `docs/reviews/tasks/L.A.md`) on staging. Record pass/fail with one line of evidence each, no secret values.
- Write `docs/reviews/tasks/LR.7-prod-plan.md`: the exact production deploy and migration runbook (D1 migrations pending on prod, DO migrations, secrets and bindings to check, rollback), plus go/no-go from the staging results. No production action.

## Check
- `docs/reviews/tasks/LR.7.md` lists each item with result. Items only Dom can judge (Office fidelity in Office, inbox receipt) list the file or mail to look at.
- Prod plan written. Production untouched.

## Log
- 2026-10-28: created; dispatched.
- 2026-10-28: round 1 merged (126cea34): 3 pass, 4 fail (one cause, LR.8), 1 needs-Dom. NO-GO. Prod lacks ARTIFACT_VIEW_KEY secret.
- 2026-10-28: round 2 dispatched after LR.6 and LR.8 merged; Dom: deploy prod straight away if green. 4d inbox receipt confirmed by Dom. Prod ARTIFACT_VIEW_KEY set by controller.
