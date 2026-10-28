---
id: LR.10
title: Peer edits arrive without a policy fetch per frame; 40px touch targets at 390px
milestone: LR
size: M
status: in_progress
depends_on: []
branch: task/LR.10-room-latency-touch
lane: web
executor: claude
---

Found by LR.7 round 2 on staging (`docs/reviews/tasks/LR.7.md`).

## Scope
- Peer edits take 2 to 20 s to arrive because `apps/web/src/components/live-artifacts/room-provider.ts:339` awaits an HTTP policy fetch for each inbound frame. Apply inbound frames without a per-frame network round trip: cache the policy and refresh it on the room's own signals (role change, access loss, reconnect) or on a timer. Access loss must still close or freeze the room as it does now (staging measured 0.2 s).
- At 390px width the Artifacts link and both export buttons are 24px high; the spec asks 40px. Make them at least 40px tall at that width without changing desktop layout.

## Check
- A test that inbound frames apply without awaiting a fetch, and a test that access loss still stops the room.
- The deck/document peer browser matrices in `docs/reviews/tasks/L.ACTIONS.md` at 1280x800 and 390x844 pass, with the controls measured at 40px or more.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-28: created from LR.7 round 2; dispatched.
