---
id: CL.4
title: One signed-token helper
milestone: CL
size: M
status: todo
depends_on: []
branch: null
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
