---
id: RH.8
title: "One avatar for an agent everywhere"
milestone: RH
size: S
status: in_progress
depends_on: [RH.7]
branch: task/RH.8-one-avatar-for-an-agent-everywhere
lane: web-agent
executor: claude
---

From the RH walkthrough (`docs/reviews/RH-e2e.md`).

The home card draws the stored avatar (colour and glyph, from RH.1). The room header, the builder's draft card, the rail, the Needs you cards, the desk cards and the task receipt draw initials and a colour taken from the name (`shell/agent-tile.ts`). One agent shows two avatars: Lunch Planner is a green "L" on the wall and a violet "LP" in its room. The stored avatar is not on `AgentRecord` or the profile header, so the room cannot read it yet.

## Scope

Carry `avatar` on the agent profile header and the other agent reads, replace `agentInitials` and `agentTileColour` with one shared component fed by the stored avatar (the draft card uses `defaultAgentAvatar(name)`), and delete the name-derived helpers.

## Check

Component tests for the shared tile. Browser: create an agent, compare its card, room header, Needs you entry and task receipt.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the RH walkthrough.
- 2026-11-21: dispatched on task/RH.8-one-avatar-for-an-agent-everywhere (v4 controller session).
