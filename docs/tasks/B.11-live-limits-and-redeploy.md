---
id: B.11
title: Live-call limits and logging, then the final staging deploy
milestone: B
size: S
status: done
depends_on: [B.10]
branch: task/B.11-live-limits-and-redeploy
lane: staging
executor: claude
---

Gaps from B.10 (`docs/reviews/tasks/B.10.md`) against R2.13 and R2.14 in `docs/v3/artifacts-prd.md`. Integration branch: `v3/artifacts`.

## Scope
1. The route-level flood guard on `POST /api/share/:token/call` and `/storage` (the `SHARE_OPEN_LIMIT` pattern with `call:` and `storage:` prefixes) allows about 30 a minute per link, below the service's 60 a minute, so R2.13's limit is never the one that applies. Raise the flood guard above the service limits (for example 120 a minute), or key it per IP prefix only, so the service limits (60/min and 1,000/day per link, 10/min per visitor) decide, and say which in the review file.
2. R2.14: every live call, allowed or refused, writes one `artifact_views` row. Make refusals that happen before the service (flood guard, dead link, bad body) write a row with surface `live_call` and the right outcome (`rate_limited`, `revoked`, `expired`, `disabled`, `refused`), when the link is known. Unknown tokens still write nothing and answer the same 404. Tests.
3. Then deploy staging once from the merged head with exactly `bun run staging:deploy` in apps/web, after `bun run staging:build` and a grep of `dist/server/wrangler.json` showing only `harbourmaster-staging`, the staging hostname and `"crons":[]`. Then check on staging: the restricted preview of a proposed app version (B.10's fix), a live call over the limit answering `rate_limited` with a row in the access log, and one `artifact_test` with no beacon error. Record it in `docs/reviews/tasks/B.11.md`.

## Check
- Tests for 1 and 2; `bun run check && bun run test && bun run build` pass; the staging lines in the review file.

## Log
- 2026-10-27: planned from B.10's gaps and dispatched (controller).
- 2026-10-27: code ready at 8eb8003, review clean after 1 fix round; SHARE_CALL_LIMIT binding (120/min); pre-service refusals logged (capped 120/min); staging deployed a5137fa2; the three staging checks are NOT run (no sign-in key in the worktree), steps for Dom in docs/reviews/tasks/B.11.md; merged.
