---
id: X.10
title: Key-authenticated admin API for setup that is UI-only today
milestone: X
size: M
status: done
depends_on: []
branch: task/X.10-admin-api
lane: admin-api
executor: claude
---

The integration coordinator sets up agents, routines and machines from Morosini with an `hm_key_`. Several steps work only from a signed-in browser session today, so each production rollout stops until Dom clicks through the UI (flips 2 and 3 in `~/devel/ai-os-integration/production-flips.md`, the controller agent for the desk panel, the desk key). This task makes those steps available to a key, with an audit trail. Mirrored in `~/devel/ai-os-integration/CONTRACTS.md` ("Requests: admin API").

## Scope
- A new `admin` scope for `hm_key_` (next to read, write and desk). Only a workspace admin can mint an admin key, in the UI. Everything below except the agent and inbox tools needs `admin`; the agent and inbox tools accept `write` or `admin`.
- MCP tools (and matching HTTP routes if that is simpler), each a thin wrapper over the service the UI already uses:
  - agents: `create_agent` and `update_agent` (name, instructions, runtime and environment, model, turn limit, network allow list, connectors).
  - secrets: `create_secret` (env and proxy kinds: host, header template, value), `grant_secret` and `revoke_secret` for an agent. Values are write-only and never returned.
  - inbox: `create_inbox_thread` (title) returning its id.
  - machines: `create_enrolment_code` returning a one-time code with its expiry.
  - skills: `assign_skill` and `unassign_skill` for keys, which today are people only.
  - keys: `create_api_key` (name, scope up to the caller's own scope) returning the key once, and `revoke_api_key`.
- Every call writes an audit event naming the key (id and name) as the actor, so the event log shows who set up what.

## Check
- Tests: a write key gets 403 on the admin tools. An admin key can do each one. A key can't mint a key with a wider scope than its own. Secret values never appear in responses or events. Each call writes one audit event.
- `bun run check && bun run test && bun run build` pass.
- Live on staging: with an admin key, create an agent, a proxy secret granted to it, an inbox thread, an enrolment code and a desk key, then revoke the key.

## Log
- 2026-10-27: requested by the integration coordinator, so production rollouts stop waiting on UI clicks.
- 2026-10-27: dispatched.
- 2026-10-27: review clean after 1 fix round; merged. assign_skill stays open to write keys (it already was); admin keys can mint admin keys.
- 2026-10-27: live check passed on staging (218c1a4f) with admin key coordinator-admin-staging: agent, proxy secret and grant, inbox thread, enrolment code, desk key minted and revoked (401 after); write key lacks the admin tools; 9 admin.action events; no secret value in responses. Test items cleaned up (agent archived). Follow-up nit: an invalid secret name shows the generic "The request failed". STATUS.md row added.
