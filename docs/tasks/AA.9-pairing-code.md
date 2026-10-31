---
id: AA.9
title: "Pairing code for outside A2A clients, modelled on Hermes"
milestone: AA
size: M
status: in_progress
depends_on: [AA.4, AA.7]
branch: task/AA.9-pairing-code
lane: worker
executor: claude
---

Spec: `docs/v3/agent-connections.md`, the section "Pairing code, for an outside client we haven't given a key". It wins over anything else. The limits are copied from Hermes's `gateway/pairing.py`: https://github.com/NousResearch/hermes-agent/blob/main/gateway/pairing.py

## Scope
- Service: `setPairingOpen` (admin or the agent's owner, session only), `requestPairing(agentId, token)` called by the route, and `approvePairingCode(agentId, code, label)` (admin or the agent's owner, session only). Approval creates an `a2a_inbound` connection under the default policies and deletes the request. Comparison is by hash. All limits in the design apply, and approving and creating the connection land in one `atomic` write so a code works once.
- `authenticate` finds a connection by the hash of any bearer token on the `/a2a` routes, not only `hm_a2a_` tokens, and a token that matches an existing connection can't be paired again. No other route learns about these tokens.
- Route: for an unrecognised token of at least 32 characters on `SendMessage`, on both bindings, when the agent's `pairing_open` is true, answer 200 with a `TASK_STATE_REJECTED` task holding the code in `status.message`. The task id and context id are generated and not stored. The body's message text is parsed only far enough to answer and is never stored or logged. Everything else stays 401, including all other operations and every request when pairing is off.
- UI on the agent's connection settings: the "Accept pairing requests" switch, saying plainly what it allows, and an "Enter a pairing code" form with a label field. No Needs you card. The "Give it a key" dialog mentions pairing as the alternative, with Hermes's steps.
- An `a2a.*` event for the switch, each request created, each wrong code, each lockout and each approval, with no codes or tokens in the payload.

## Check
- Tests cover, each as its own test:
  - Pairing off, and a short token, both answering 401 with no row written.
  - A code returned, the same token getting the same code back, and a fourth pending request refused.
  - Expiry at 1 hour.
  - Lockout after 5 wrong codes, and a right code refused during lockout.
  - A right code creating a connection at `approve` and `ask`, the token then working, and the code failing a second time.
  - Non-`SendMessage` operations answering 401 with pairing on.
  - The message text, the code and the token absent from the database and from event payloads, apart from their hashes.
  - A run principal and an API key refused on the switch and on approval.
  - The token still refused at `/mcp` after pairing.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-01: created from Dom's question about supporting Hermes's pairing.
- 2026-11-01: AA.1 stores only a hash of the code. Decision: derive the code as an HMAC of the request id and the token under the secrets key, so the same token gets the same code back and no plaintext or reversible code is stored.
- 2026-11-01: dispatched.
