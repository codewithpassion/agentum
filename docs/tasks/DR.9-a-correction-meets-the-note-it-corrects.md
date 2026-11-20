---
id: DR.9
title: "A correction meets the note it corrects"
milestone: DR
size: S
status: done
depends_on: [DR.7]
branch: task/DR.9-a-correction-meets-the-note-it-corrects
lane: services-dream
executor: claude
---

From the dream walkthrough (`docs/reviews/DR-e2e.md`).

## Scope

when a candidate is a correction, or when the merge step looks for duplicates, compare it with every note of the same scope, not only the same kind. A same-scope note that the judge says the candidate replaces is dropped or merged, with the kind of the newer note kept.

## Check

a service test with a fake model where an `people` note says 1pm and a conversation says it moved to 1:30pm: the plan has one note left. `bun run check && bun run test && bun run build` pass. Then repeat the walkthrough's flow 1 and read the notes list.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the dream walkthrough.
- 2026-11-21: dispatched.
- 2026-11-21: ready at 39225a7a after one fix round, review clean. Real-model check (claude-haiku-5-5, $0.00018): the 1pm note was replaced by one 1:30pm note. Queued for merge.
- 2026-11-21: merged 0bfc4107, batch merge check with RH.11, DR.10, DR.9 and SP.8 passed. Done.
