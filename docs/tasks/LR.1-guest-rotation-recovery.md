---
id: LR.1
title: Guest session survives an interrupted committed rotation
milestone: LR
size: L
status: todo
depends_on: []
branch: null
lane: services
executor: claude
---

Item 1 of `docs/reviews/tasks/L.HANDOFF.md`. Background and the fixture negative control: `docs/reviews/tasks/LG.RELOAD.md`.

When the server commits replacement-token state for a rotating guest session but navigation or termination stops the browser receiving the new HttpOnly cookie, the browser keeps an invalid credential and the guest loses the session.

## Scope
- Write a short design note first (in `docs/reviews/tasks/LR.1.md`): how a guest whose rotation response was lost recovers, without relaxing grant or role checks and without broadly accepting replay of old tokens (for example a bounded, single-use grace for the immediately previous token tied to the same session, or an equivalent coordinated scheme).
- Failing tests first: deterministic response loss after commit, Worker restart between commit and delivery, two concurrent tabs rotating at once, and replay of an old token after recovery (must be refused).
- Implement the recovery. Revocation, expiry and the five-second revocation deadline still win over recovery.

## Check
- New tests fail before the fix and pass after.
- The guest browser checks named in `LG.RELOAD.md` still pass.
- `bun run check && bun run test && bun run build` pass.
- Security-focused review of the change records a clean verdict in `docs/reviews/tasks/LR.1.md`.

## Log
- 2026-10-28: created from L.HANDOFF.md.
