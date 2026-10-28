---
id: LR.8
title: Live-room and export auth pass the Clerk publishable key
milestone: LR
size: S
status: in_progress
depends_on: []
branch: task/LR.8-live-room-clerk-key
lane: services
executor: claude
---

Found by LR.7 on staging (`docs/reviews/tasks/LR.7.md`): every member live-room WebSocket is rejected (403) and every export fails (500). `apps/web/src/server/live-artifacts/auth.ts:53` and `:30` call `createClerkClient` without `publishableKey`, so `authenticateRequest` throws on deployed Workers.

## Scope
- Pass `publishableKey: env.CLERK_PUBLISHABLE_KEY` (or the shared Clerk client helper the rest of the app uses, if one exists) at both call sites, and any other `createClerkClient` call in apps/web that later calls `authenticateRequest` without it.
- Find out why local tests and local browser runs didn't catch it and close that gap if cheap.

## Check
- A test that fails without the publishable key and passes with it.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-28: created from LR.7 round 1; dispatched.
