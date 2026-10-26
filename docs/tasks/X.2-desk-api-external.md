---
id: X.2
title: External desk API for flightdex (Needs you, decisions, controller messages, stream)
milestone: X
size: M
status: todo
depends_on: [V1.4, V1.5, V2.8]
branch: null
lane: services
executor: claude
---

flightdex-v2 will show Harbourmaster's Desk in a panel. It renders the same React module as the Harbourmaster Desk (`packages/desk-widget`, built in the integration workstream) and reaches Harbourmaster only through its own server, the way its ops tile reads control-plane. No iframes and no CORS. This task adds the server routes it calls. The contract is C4 in `~/devel/ai-os-integration/CONTRACTS.md`.

## Scope
- Auth: an `hm_key_` API key with a new `desk` scope (next to read and write in `api-keys`). Every request also carries `X-On-Behalf-Of: <email>`. The server resolves that email to a workspace member and acts as that member; an unknown email or a non-member answers 403. Once both apps share one production Clerk instance (X.1), a user's Clerk OAuth token is accepted on the same routes and the header is ignored.
- Routes, mounted outside the cookie group, all thin wrappers over V1.5 requests and V2.8 desk services:
  - `GET /api/desk/needs-you` returns `[{ requestId, kind: "approval" | "question", runId, agent, title, detail, createdAt, expiresAt }]`.
  - `POST /api/desk/requests/:id/decision` with `{ decision: "allow_once" | "always" | "deny", answer?: string }`. First answer wins, as on web and Slack.
  - `POST /api/desk/controller/messages` with `{ text, threadId? }` returns `{ runId, sessionId }`. It sends to the workspace's controller agent.
  - `GET /api/desk/stream` is the V1.4 SessionStream SSE for the member's desk, resumable with `Last-Event-ID`.
- Decisions made here are recorded with the acting member as the decider, like a web decision.

## Check
- Route tests: 401 without a key, 403 for a key without the `desk` scope, 403 for an email that is not a member, a decision through this route resolves the request exactly once when Slack answers at the same time.
- `bun run check && bun run test && bun run build` pass.
- Live on staging: `curl` each route with a desk key; the stream delivers a new request within a second.

## Log
- 2026-10-26: requested by the integration coordinator (contract C4).
