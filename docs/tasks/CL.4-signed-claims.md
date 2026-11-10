---
id: CL.4
title: One signed-token helper
milestone: CL
size: M
status: done
depends_on: []
branch: task/CL.4-signed-claims
lane: services
executor: claude
---

From the 10 Nov 2026 review. HMAC signed tokens are implemented four times: `run-tokens.ts`, `artifacts/view-token.ts`, `live-artifacts/ticket.ts`, and `apps/web/src/server/live-artifacts/room-admission.ts`.

## Scope

- `signClaims`, `openClaims` and `sha256Hex` in `crypto.ts`. The four callers use them. Token formats stay the same, so live tokens keep working.

## Check

- A token minted by the old code verifies with the new, for each of the four.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
- 2026-11-11: Dom lifted the cleanup hold. Dispatched to a Sonnet implementer on task/CL.4-signed-claims, with a per-task review as team-lead relayed, in parallel with the other CL tasks.
- 2026-11-11: Merged as 648b7d7c, review clean with 0 fix rounds. check, test and build passed on main at 27789cdd, and the bundle grep was empty.
