---
id: TM.4
title: "Lead role: team tools and proposals"
milestone: TM
size: M
status: done
depends_on: [TM.3]
branch: task/TM.4-lead-role-tools
lane: mcp
executor: claude
---

From `docs/v4/build-plan.md`, milestone TM. A lead coordinates. It may propose changes to its members and never writes them.

## Scope

- Tools in `packages/mcp/src/tools/` for a run woken by a team room whose agent is that team's lead: `team_post(topic, text)`, `team_open_topic(title, members?)`, `team_members()`, `team_propose_change(agentId, field, value, reason)` where field is `instructions`, `model`, `effort` or `contextBudget`.
- `team_propose_change` creates an approval request for the member's owner through `requests`. On approval the service applies the change. Access, keys, ask-before rules and connectors can never be proposed.
- In a room run the lead gets team tools, read tools and `send_message` only. This is a tool restriction applied where the run's tool list is built, not a prompt line. In its own conversations the agent keeps its normal tools.
- `admin-access.ts` stays as it is: a run principal still cannot manage another agent directly.

## Check

- Tool tests: non-lead refused, proposal approved and applied, proposal rejected, forbidden field refused, the room-run tool list.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/TM.4-lead-role-tools (v4 controller session).
- 2026-11-20: merged as 99d909ff, review clean after 1 fix round. check, test and build passed on main.
