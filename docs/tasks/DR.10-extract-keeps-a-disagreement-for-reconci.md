---
id: DR.10
title: "Extract keeps a disagreement for reconcile"
milestone: DR
size: S
status: in_progress
depends_on: [DR.7]
branch: task/DR.10-extract-keeps-a-disagreement-for-reconci
lane: services-dream-inputs
executor: claude
---

From the dream walkthrough (`docs/reviews/DR-e2e.md`).

## Scope

change the extract prompt in `extract.ts` so two pieces of evidence that disagree, with no word of correction, become two candidates, and so a note never says "previously noted" or "unclear, confirm".

## Check

extract tests with a fake model for both shapes. A real-model run of two people disagreeing in two conversations ends with a question in Needs you. The cost of that run is in the diary's usage row.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the dream walkthrough.
- 2026-11-21: dispatched.
