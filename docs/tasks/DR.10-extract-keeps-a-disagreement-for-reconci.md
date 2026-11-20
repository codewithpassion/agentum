---
id: DR.10
title: "Extract keeps a disagreement for reconcile"
milestone: DR
size: S
status: done
depends_on: [DR.7]
branch: task/DR.10-extract-keeps-a-disagreement-for-reconci
lane: services-dream-inputs
executor: claude
---

From the dream walkthrough (`docs/reviews/DR-e2e.md`).

## Scope

change the extract prompt in `extract.ts` so two pieces of evidence that disagree, with no word of correction, become two candidates, and so a note never says "previously noted" or "unclear, confirm".

## Check

extract tests with a fake model for both shapes. A real-model run of two disagreeing conversations ends with two candidates, not one merged note. The question in Needs you moved to DR.16.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the dream walkthrough.
- 2026-11-21: dispatched.
- 2026-11-21: scope fixed by controller. The dispatcher found reconcile only questions notes that already exist and skips groups written only by a dream, so a prompt change alone can't raise a question. DR.10 keeps the prompt change. The Needs you question moves to DR.16 (services-dream lane, after DR.9).
- 2026-11-21: ready at d76544bc, review clean with no fix rounds. Queued for merge.
- 2026-11-21: merged b72ee61d, batch merge check with RH.11, DR.10, DR.9 and SP.8 passed. Done.
