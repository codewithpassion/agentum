---
id: X.2
title: External desk API for flightdex (Needs you, decisions, controller messages, stream)
milestone: X
size: M
status: done
depends_on: [V1.4, V1.5]
branch: task/X.2-desk-api-external
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

## Refinements (26 Oct 2026, controller)

Dom's priority on 26 Oct: X.3, X.4, then X.2, then V2.8. V2.8 is three V2 tasks away, so X.2 is split: this task builds the first three routes over V1.5's requests service, and X.6 adds `GET /api/desk/stream` once V2.8's desk service exists. The request and response shapes stay exactly as in C4 (`~/devel/ai-os-integration/CONTRACTS.md`). If a shape has to change, write the change into this file and stop.

- `needs-you` reads pending requests from V1.5 for the member's workspace, not from a desk service. Fill `agent`, `title` and `detail` from the request's stored, scrubbed display.
- There is no "controller agent" in Harbourmaster today. Use the workspace's agent named `controller` (case-insensitive) and answer 404 when there is none. No schema change for it; record the choice in the review file so the coordinator can confirm it.
- The `desk` scope may need a change in `packages/db/src/schema`. That is allowed here because no other task holds the db lane until V2.1, which waits for the V1 gate. Generate and commit the migration as CLAUDE.md says.

## Check
- Route tests: 401 without a key, 403 for a key without the `desk` scope, 403 for an email that is not a member, a decision through this route resolves the request exactly once when Slack answers at the same time.
- `bun run check && bun run test && bun run build` pass.
- Live on staging (controller, after merge): `curl` each route with a desk key.

## Log
- 2026-10-26: requested by the integration coordinator (contract C4).
- 2026-10-26: Dom confirmed the integration coordinator is his and may add task files.
- 2026-10-26: split; the stream route moved to X.6 (after V2.8). depends_on drops V2.8.
- 2026-10-26: dispatched.
- 2026-10-26: review clean after 1 fix round; code merged at c83542c. No migration needed. Open for Dom: any member can mint a desk key and act as any other member (no admin role). Clerk OAuth tokens refused on /api/desk until the coordinator names which client to allow. Staging deploy and curl check after V1.15.
- 2026-10-26: Dom accepts the desk-key scope for now (any member mints, acts as any member). OAuth client for /api/desk left open, by Dom's decision. Deployed to staging (4a3e1503) and production (955ef460).
- 2026-10-26: staging curl check passed in Dev Workspace (all routes, auth errors, 409 on second answer). Not covered live: approval-kind items. Done.
- 2026-10-26: BLOCKED (desk-panel sub-controller): the 'controller' agent exists in the HEI staging workspace (checked with the write key via MCP list_agents). A desk-scope hm_key_ for that workspace cannot be minted with a write key: api_keys.create is a cookie-session tRPC mutation only. Request: mint a desk key in the HEI staging workspace (Settings > API keys, signed in as a member such as dominik.fretz@harbouredgeintelligence.com) and store it at ~/.config/ai-os/hm-staging-desk-key (mode 600), or add a key-authenticated way to mint one. The key in tmp/X-checks/desk-key belongs to Dev Workspace and was not used.
- 2026-10-26: HEI staging desk key flightdex-desk-staging minted for the desk panel (Dom approved), at ~/.config/ai-os/hm-staging-desk-key.
