---
id: LR.14
title: Live rooms authorize once per participant window, not per frame
milestone: LR
size: M
status: in_progress
depends_on: [LR.10]
branch: task/LR.14-room-authorize-cache
lane: services
executor: claude
---

Found by LR.7 round 3 on staging (`docs/reviews/tasks/LR.7.md`). Document peer edits still take 1.9 s for one character and about 6 s for three quick ones; eight concurrent room admissions took up to 12.7 s and two got no frame within 15 s. LR.10 removed the client-side policy fetch; the wait is now on the server: `artifact-room.ts:1148` awaits `authorize` per inbound frame inside `exclusive`, which reaches `production-room.ts:64-84` and `:280` (Clerk plus membership lookup), and `refreshSocket` (`artifact-room.ts:2034-2065`) queues a role control every ~3 s on the same queue.

## Scope
- Authorize a participant on admission and then reuse that decision for a short window (seconds) instead of per frame; re-authorize off the frame path. Don't hold `exclusive` across network calls.
- Revocation stays immediate: `accessFence` and the existing access-loss path (staging measured 0.2 s close) still stop a revoked participant before their next frame applies. Role downgrade (editor to viewer) takes effect within the same bound as today or better.
- Admission of many participants at once does not serialize on Clerk/D1 lookups.
- Applies to document and deck rooms alike; coordinate with LR.12 (deck client) only through main.

## Check
- Tests: frames apply without an authorize call per frame; revocation via `accessFence` blocks the next frame; role downgrade blocks writes; eight concurrent admissions complete without serial lookups.
- Security-focused review of the change records a clean verdict.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-28: created from LR.7 round 3; dispatched.
