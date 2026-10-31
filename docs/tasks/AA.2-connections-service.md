---
id: AA.2
title: "Connections service: publishing, invites, pairing, access keys, revoke"
milestone: AA
size: L
status: todo
depends_on: [AA.1]
branch: null
lane: services
executor: claude
---

Spec: `docs/v3/agent-connections.md`, the sections "Trust flows", "Policies on a connection" and the "Who may" rows of "Decisions". It wins over anything else.

## Scope
`packages/services/src/a2a/connections.ts`, a factory taking `{ db, atomic, clock, secretsKey, events, ... }`, built in `composeWith` and added to `Services`. No HTTP in this task: anything that must reach a peer goes in as an `a2a_outbox` row or through an injected transport port, so AA.5 can supply the real one.

- Publishing: `publish` (owner-reviewed description and skills, random public id) and `unpublish`, plus `publicCard(publicId)` for the route. Never reads `instructions`.
- Harbourmaster pairing, both sides:
  - Inviter: `createInvite`, `join` (called by the route with the invite token), `approve`, `decline`. Invite is 7 days, single use, 5 failed tries, compare-and-set so two joins can't both win.
  - Joiner: `joinWithLink`, `activate` (called by the route with the token the joiner issued), `declined`.
  - The check code: 8 characters from a hash of both tokens, the same on both sides, in the alphabet "Pairing code" in the design gives.
  - On the same deployment, take the peer's organisation name from our own workspace row and refuse a connection within one workspace. Refuse a second live connection between the same agent and the same peer card.
- Access keys: `createAccessKey` for an outside client, token shown once, `peer_kind = a2a_inbound`.
- External agents: `addOutbound` from a fetched card (injected), which keeps the approved origin and stores the credential encrypted with the secrets key. `refreshCard`, which returns the connection to `needs_approval` when the interface origin changes. Only the schemes the design lists are accepted.
- `setPolicies` and `revoke`. Revoke sets the row, queues the notice to a Harbourmaster peer, and fires a hook AA.3 uses to end tasks and runs. `peerRevoked` handles the incoming notice. Archiving an agent revokes its connections.
- `authenticate(token)`: resolves `hm_a2a_` to a connection on every call, with no cache, and returns a new `peer` principal only for an `active` connection with a published agent. This is not added to `createPrincipalResolver`, so the token works nowhere but the `/a2a` routes.
- `Principal` gains `{ kind: "peer", workspaceId, connectionId, agentId }`. `authz.can` denies it everything except `a2a.*` and `runs.start`. `eventActor` and `deriveSubject` get a `peer` case: depth from the hop count clamped to `MAX_RUN_DEPTH`, `parentRunId` null, `onBehalfOfUserId` null, and refused unless `agentId` matches, like a trigger.
- Authorisation: creating, approving and widening need a session user who is an org admin or the agent's owner (`owner_user_id`, falling back to `created_by`). Revoke and `inbound_policy = off` need any session member. API key, OAuth, run and machine principals are refused on all of them.
- An `a2a.*` event for every state change. List and detail reads with `authorize()`.

## Check
- Service tests against `migrated()` cover, each as its own test:
  - A full pairing on two workspaces, ending with both rows `active` and both tokens working.
  - An expired invite, a reused invite, and the sixth bad try.
  - A run principal, an API key and a read-only OAuth client each refused on create, approve and widen.
  - A non-owner member refused on approve and allowed on revoke.
  - A revoked token failing on the next `authenticate` with no other step, and a decline leaving no usable token.
  - The origin change returning a connection to `needs_approval`.
  - The `peer` principal refused on any action outside the allowed set, and on `runs.start` for another agent.
  - The plaintext token and the credential appearing nowhere in the database or in event payloads.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-31: created.
