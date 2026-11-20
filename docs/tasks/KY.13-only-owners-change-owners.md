---
id: KY.13
title: "Only an agent's owners or an admin change its owners"
milestone: KY
size: S
status: in_progress
depends_on: [KY.10]
branch: task/KY.13-only-owners-change-owners
lane: services-agents
executor: claude
---

From the KY.10 review (`docs/reviews/tasks/KY.10.md`). `agents.setOwners` lets any member name themselves an owner, which gets around the KY.8 and KY.10 rule that only owners and admins manage an agent's keys.

## Scope

- `agents.setOwners` (the service and the MCP `set_agent_owners` tool) refuses anyone who is not a current owner of the agent or a workspace admin.
- The Owner and Backup controls in the agent room are disabled for everyone else.

## Check

- Service tests: an owner and an admin can change owners, a plain member is refused and the owners stay unchanged, and the MCP tool follows the same rule.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the KY.10 review. Rule follows Dom's KY.8 decision (owners and admins).
- 2026-11-20: dispatched on task/KY.13-only-owners-change-owners (v4 controller session).
