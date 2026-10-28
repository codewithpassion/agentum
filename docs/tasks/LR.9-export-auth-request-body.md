---
id: LR.9
title: Exports authenticate without consuming the request body twice
milestone: LR
size: S
status: done
depends_on: [LR.8]
branch: task/LR.9-export-auth-body
lane: services
executor: claude
---

Found by LR.7 round 2 on staging (`docs/reviews/tasks/LR.7.md`): every member export returns 500 with "Cannot reconstruct a Request with a used body". `apps/web/src/server/live-artifacts/auth.ts:93` consumes the body when it builds the Clerk request, then the second authenticate at `apps/web/src/server/live-exports/routes.ts:43` throws.

## Scope
- Build the Clerk authentication request without the body (Clerk needs only URL and headers), so authenticating any number of times never touches the body. Check every caller of the helper in auth.ts for the same pattern.
- The export route still reads its own body afterwards.

## Check
- A test that authenticates twice on a POST with a body, then reads the body, and fails before the fix.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-28: created from LR.7 round 2; dispatched.
- 2026-10-28: merged at 304096f4, review clean (0 fix rounds). Merge check: guest-execution.test.ts failed once under load (workerd 'other side closed'), passed on rerun on merged main and before/after LR.9 in the worktree: load-sensitive, not LR.9.
