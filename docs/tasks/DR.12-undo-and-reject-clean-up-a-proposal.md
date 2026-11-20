---
id: DR.12
title: "Undo and Reject clean up a proposal"
milestone: DR
size: S
status: done
depends_on: [DR.7]
branch: task/DR.12-undo-and-reject-clean-up-a-proposal
lane: services-skills
executor: claude
---

From the dream walkthrough (`docs/reviews/DR-e2e.md`).

## Decision

Controller decision (Dom's "don't wait for me", 20 Nov 2026): Undo withdraws the night's skill proposal, and rejecting a skill whose only version was rejected unassigns it.

## Scope

make Undo withdraw the night's proposal, and unassign a skill whose only version was rejected.

## Check

service tests for both, and the Knows tab no longer lists a skill with no approved version after a reject.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the dream walkthrough.
- 2026-11-21: dispatched.
- 2026-11-21: ready at db49d2a0 after one fix round, review clean. Queued for merge.
- 2026-11-21: merged e94fe831, batch merge check with DR.16, DR.12 and SL.12 passed. Done.
