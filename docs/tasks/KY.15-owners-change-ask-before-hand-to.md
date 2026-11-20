---
id: KY.15
title: "Only owners and admins change ask-before rules and hand-to agents"
milestone: KY
size: S
status: done
depends_on: []
branch: task/KY.15-owners-change-ask-before-hand-to
lane: services-requests
executor: claude
---

From the KY gate review, round 1 (`docs/reviews/KY-1.md`).

## Decision

Controller decision (20 Nov 2026): ask-before rules and hand-to agents are keys, as the v4 Vocabulary table says, so Dom's KY rule applies: only the agent's owners and admins change them. Answering a request with Always allow stays open to any member.

## Scope

- `agentProfile.setAskBefore`, `agentProfile.setAskLevel`, the `requests.setRule` and `requests.removeRule` procedures, and `agents.update` when `handsTo` is present all call `requireAgentOwnerOrAdmin` for the agent. The MCP `set_agent_ask_before` tool follows the same rule.
- The "Always allow" answer on a request stays open to any member. CLAUDE.md says any member may answer any request, and the answer path calls `setRule` internally. Put the new check where it does not block that path, for example in the router-facing methods or behind a flag the answer path sets.
- The Keys tab disables the ask-before card and the hand-to panel for everyone else, with the same note the other sections use.

## Check

- Service tests for owner, admin and plain member on each of the five writes. A refused call leaves the rules, the level and `hands_to` unchanged. A plain member's "Always allow" answer still writes its allow rule.
- Browser as a plain member: the ask-before switches, the level and the hand-to choices are disabled. As the owner, they work.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the KY gate review, round 1.
- 2026-11-20: dispatched on task/KY.15-owners-change-ask-before-hand-to (v4 controller session).
- 2026-11-20: merged as 6f33f630, review clean after 0 fix rounds. Browser proof passed at both sizes: docs/reviews/tasks/KY.15/browser.md. check, test and build passed on main.
