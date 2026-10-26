---
id: X.6
title: Desk stream for external callers (C4 GET /api/desk/stream)
milestone: X
size: S
status: todo
depends_on: [X.2, V2.8]
branch: null
lane: worker
executor: claude
---

Split from X.2 on 26 Oct 2026. The last C4 route, `GET /api/desk/stream`, needs V2.8's desk service to know what belongs on a member's desk. The contract is C4 in `~/devel/ai-os-integration/CONTRACTS.md`; keep its shape. If it has to change, write the change into this file and stop.

## Scope

- `GET /api/desk/stream`, with X.2's auth (`hm_key_` with the `desk` scope plus `X-On-Behalf-Of`), as an SSE stream of the member's desk built on V1.4's SessionStream and V2.8's desk service, resumable with `Last-Event-ID`.

## Check

- Route tests: auth as in X.2, a resumed stream with `Last-Event-ID` sends nothing twice.
- `bun run check && bun run test && bun run build` pass.
- Live on staging (controller, after merge): the stream delivers a new request within a second.

## Log
- 2026-10-26: split from X.2.
