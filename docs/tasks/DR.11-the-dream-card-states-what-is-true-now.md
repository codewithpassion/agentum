---
id: DR.11
title: "The dream card states what is true now"
milestone: DR
size: S
status: in_progress
depends_on: [DR.7]
branch: task/DR.11-the-dream-card-states-what-is-true-now
lane: web-knows
executor: claude
---

From the dream walkthrough (`docs/reviews/DR-e2e.md`).

## Scope

in `components/agent/room/knows/dream/`, show the state line (held, approved, rejected, undone, question answered) in place of the held and question sentences once they no longer apply, and word the "Would add" lines as past tense after approval.

## Check

component tests for held, approved, rejected, question answered and undone, and a browser pass at both sizes.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the dream walkthrough.
- 2026-11-21: dispatched.
