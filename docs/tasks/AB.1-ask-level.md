---
id: AB.1
title: An ask level per agent, with grouped overrides
milestone: AB
size: M
status: in_progress
depends_on: []
branch: task/AB.1-ask-level
lane: services
executor: claude
---

From the 10 Nov 2026 review. The "Ask me before it" card is one long open list, and tools from a newly added connector arrive as allow. Files: `packages/services/src/agent-profile/ask-before.ts`, `apps/web/src/components/agent/profile/ask-before-card.tsx`.

## Scope

- An ask level on the agent: "Ask rarely", "Ask before it acts outside", "Ask before everything". New tools follow the level.
- `agent_tool_rules` rows become overrides. The migration marks agents that have rows as custom, so nothing changes for them.
- The card shows the level. "Customise" opens the switches grouped by source, one collapsed group per connector with a group switch and "n of m ask". The "Covers" text shows once per group.
- `send_message` and `start_subagent` become gateable actions.
- Keys that are not in `gateableActions` are refused, in the service, for the UI and `set_agent_ask_before`.

## Check

- Service tests for each level, an override, a new connector tool following the level, and an unknown key.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
- 2026-11-10: dispatched to a Sonnet implementer on task/AB.1-ask-level. Second schema task, started after TH.1 merged so its migration follows TH.1's.
