---
id: TX.9
title: "A team dream question names the team"
milestone: TX
size: S
status: in_progress
depends_on: []
branch: null
lane: services-desk
executor: claude
---

From the team extras walkthrough (`docs/reviews/TX-e2e.md`).

Finding. The question reaches Needs you as "Ada has a question from its dream" with Ada, a member, as the name. The question belongs to the team (its `agent_id` is null and its `team_id` is set), so the heading should name the team: "Crew has a question from its team dream". The desk picks the lead (or the lowest-id member) as the card's agent on purpose (`teamQuestionAgents` in `packages/services/src/desk.ts`), and that also decides who sees the card, so the agent stays. The heading (`packages/db/src/shared.ts`, `NEEDS_YOU_HEADINGS.dream_question`) takes an agent name only.

Scope. Keep the card's agent, add the team name to the card for a team question, and pick the heading from it.

Check. A desk test with a team question, and the Needs you pane in the browser.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-21: added by controller from the TX walkthrough.
- 2026-11-21: dispatched.
