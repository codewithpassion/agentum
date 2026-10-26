---
id: X.6
title: Desk stream for external callers (C4 GET /api/desk/stream)
milestone: X
size: S
status: in_progress
depends_on: [X.2]
branch: task/X.6-desk-stream
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

## Refinements (2026-10-26)

Checked against main at 4da1878. Where these differ from the scope above, they win.

- The scope does not fit as written. `SessionStream` is one Durable Object per session, but a member's desk spans sessions, and V2.10 builds no workspace stream. V2.8 adds nothing this stream needs: C4's needs-you items are approvals and questions only, which X.2 already serves from V1.5. depends_on drops V2.8.
- Fan-out: reuse the `SessionStream` class under one more instance name per workspace, such as `desk:<workspaceId>`. No new class means no wrangler migration and no `wrangler deploy`-only release. `streamListener` in `apps/web/src/server/session-stream-port.ts` also publishes the `request.*` and `run.*` frames of every session to that instance.
- Filter per member. A frame's `runId` leads to a session the member may see under `visibleSessions` (the rule `listPending` uses); cache the answer per connection. Another member's ui session or private DM must never leak.
- Replay: `events.query(member, { after, types, limit: 500 })` with the exact `request.*` and `run.*` types. It applies `visibleSessions` itself. Subscribe first, replay, then drop duplicate ids, as `routes/session-stream.ts` does, and reuse `session-stream-frames.ts` for the frames.
- Auth: mount `GET /stream` in `routes/desk.ts` and use its `memberOrRefusal`. Stamp the key once per connection.
- Frames keep the `@repo/protocol/stream` shapes. C4 names no frame set, so record the one chosen (`request.*` and `run.*` event frames plus `run` and `ping` frames) in the review file for the integration coordinator to confirm.

## Log
- 2026-10-26: split from X.2.
- 2026-10-26: refined against the code (controller). depends_on drops V2.8: the C4 stream needs only V1.4's stream and V1.5's requests, see Refinements.
- 2026-10-26: dispatched.
