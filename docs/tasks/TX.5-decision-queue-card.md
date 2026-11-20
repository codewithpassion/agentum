---
id: TX.5
title: "Decision queue card in the web app"
milestone: TX
size: S
status: in_progress
depends_on: [TX.4]
branch: task/TX.5-decision-queue-card
lane: web-requests
executor: claude
---

From `docs/v4/build-plan.md`, milestone TX. Render the `decisions` request.

## Scope

- A card in `components/requests/` listing the questions with an option button row each, progress ("3 of 5 answered"), Send answers and Dismiss.
- It renders in the Needs you pane, inline in a conversation and inline in a room post.

## Check

- Component tests for partial state and dismiss. Browser check with the fake runtime.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-21: dispatched on task/TX.5-decision-queue-card (v4 controller session).
