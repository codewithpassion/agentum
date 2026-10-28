---
id: LR.17
title: Concurrent room admissions don't queue in the room Durable Object
milestone: LR
size: S
status: todo
depends_on: [LR.15]
branch: null
lane: services
executor: claude
---

LR.7 round 5 (`docs/reviews/tasks/LR.7.md`): single joins pass (median 1.6 s, max 2.6 s) but eight concurrent joins reach 7.4 s, with 6 of 24 under 3 s. Suspects: the second `live().admit` at `production-room.ts:416/432` after `routes.ts:59`, and `storeCredential` plus `roomIdentity` (`production-room.ts:318`, one Clerk `users.getUser` per join) queuing in the one ProductionRoom DO.

## Scope
- Trace server-side timings first (staging `wrangler tail`), then remove the serial step. Keep LR.14/LR.15 security properties.

## Check
- Eight concurrent joins on staging all reach first frame under 3 s, three rounds.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-29: created from LR.7 round 5; accepted as non-blocking for the production deploy.
