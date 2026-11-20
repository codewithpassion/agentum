---
id: KY.8
title: "Only an agent's owner or an admin sets the agent's credential"
milestone: KY
size: S
status: todo
depends_on: [KY.3, KY.5]
branch: null
lane: services-connectors
executor: claude
---

From the KY.3 review (`docs/reviews/tasks/KY.3.md`). Any workspace member can still set or replace an agent's credential: `setCredential` with an `agentId`, and OAuth `start` with an agent owner. KY.3 left it open because its scope names only the caller's own credential, and the agent profile's connectors sheet relies on members doing it.

## Scope

- An agent's owners and workspace admins may set or replace the agent's credential. Plain members may not (Dom, 20 Nov 2026).
- Enforce that rule in the connectors service and the OAuth start route, with tests for owner, admin and plain member.
- The Keys tab hides the agent-credential actions from people the rule refuses.

## Check

- Service tests cover owner, admin and member for `setCredential` and OAuth start on an agent credential.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the KY.3 review. Blocked: needs Dom to decide who may set an agent's credential (its owners, admins, or both).
- 2026-11-20: Dom decided: both the agent's owners and admins may set it. Unblocked.
- 2026-11-20: depends on KY.5 too, because its last scope line changes the Keys tab KY.5 is building.
