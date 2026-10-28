---
id: LR.15
title: Room admission runs the Clerk check once, not in both route and Durable Object
milestone: LR
size: S
status: done
depends_on: [LR.14]
branch: task/LR.15-room-admission-auth
lane: services
executor: claude
---

LR.7 round 4 (`docs/reviews/tasks/LR.7.md`): one room join takes 2.2 s and eight at once take up to 13.3 s to their first frame (bar: 3 s). The route and the DO each run the full Clerk check (`live-artifacts/routes.ts:46`, `production-room.ts:396`, `auth.ts:39/98/105`, about 0.7 s each).

## Scope
- Authenticate once per admission. The route already verifies the member; hand the DO a verified, short-lived, room-bound credential (the existing room ticket if it fits) instead of re-running Clerk, keeping membership/role checks the DO needs. No weakening: the DO still refuses forged, expired, replayed or other-room tickets.
- Find what else makes a single join take 2.2 s and remove serial waits where safe.

## Check
- Tests for forged/expired/other-room tickets refused, and that admission makes one Clerk verification.
- Security-focused review clean.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-29: created from LR.7 round 4; dispatched.
- 2026-10-29: merged at bf8f3136, security review clean after 1 fix round. One Clerk name lookup per join remains (follow-up).
