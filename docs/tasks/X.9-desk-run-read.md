---
id: X.9
title: Desk API route to read a run's status and reply
milestone: X
size: S
status: todo
depends_on: [X.2]
branch: null
lane: services
executor: claude
---

The flightdex desk panel sends a message to the controller with `POST /api/desk/controller/messages` and gets `{ runId, sessionId }` back. It can't show the controller's reply: `/api/desk/stream` carries only `request.*` and `run.*` frames, the session stream takes a Clerk cookie only, and `/api/desk/*` has no read route. Contract C4 in `~/devel/ai-os-integration/CONTRACTS.md` ("Requests from the desk panel").

## Scope
- `GET /api/desk/runs/:runId` with the same auth as the other desk routes (desk-scope `hm_key_` plus `X-On-Behalf-Of`), returning `{ runId, sessionId, status, reply, error }`. `reply` is the run's final assistant text (the stored, scrubbed result), null while the run is not finished.
- Only runs the acting member can see (same visibility as `get_run`); otherwise 404.
- Optional, if cheap: `run.*` frames on `/api/desk/stream` for the member's own controller runs carry `runId`, so flightdex polls only after a frame instead of every 2 s.

## Check
- Route tests: 401 without a key, 403 for a non-member, 404 for another member's private run, `reply` null while running and set when done.
- `bun run check && bun run test && bun run build` pass.
- Live on staging: send a controller message through the desk API, then read it back with this route until `reply` is set.

## Log
- 2026-10-27: requested by the integration coordinator (desk panel shows the controller's reply).
