---
id: DR.8
title: "Approve or reject a held dream batch"
milestone: DR
size: S
status: in_progress
depends_on: [DR.4, DR.6]
branch: task/DR.8-held-dream-batch-approval
lane: web-knows
executor: claude
---

From the DR.4 review (`docs/reviews/tasks/DR.4.md`). When a dream is held (the agent's learn level is "ask first", or the batch rests on outside evidence), nothing in the app lets the owner approve or reject it. `dream.decide` exists, but the dream diary on the Knows tab (DR.6) has no button for it, and the Needs you drawer hides those rows because `memory.decide` refuses them.

## Scope

- A held dream shows on the Knows tab's dream diary with its proposed changes and Approve and Reject, which call `dream.decide`.
- The Needs you drawer shows a card for a held dream that opens it, using `dream.decide` rather than `memory.decide`.
- Only the agent's owners and admins can decide; others see the batch read-only.

## Check

- Component tests for the diary's held state and the Needs you card.
- Browser at desktop and phone: a seeded held dream shows on Knows and in Needs you; Approve applies it and Reject leaves memory unchanged.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the DR.4 review.
- 2026-11-20: dispatched on task/DR.8-held-dream-batch-approval (v4 controller session).
