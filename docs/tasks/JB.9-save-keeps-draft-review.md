---
id: JB.9
title: "Save keeps what the draft review shows"
milestone: JB
size: S
status: done
depends_on: []
branch: task/JB.9-save-keeps-draft-review
lane: builder
executor: claude
---

From the JB gate review, round 1 (`docs/reviews/JB-1.md`).

Controller decision, 20 Nov 2026: take path (a). Save keeps `asksBefore` and `deliversTo` as plain lines in the saved prompt, so the person's words are not dropped.

## Scope

- Choose one path and do only that:
  - (a) When a draft has `asksBefore` or `deliversTo`, `draftRoutineInput` adds them to the saved prompt as plain lines after `does`, for example "Ask first: ..." and "Send the result to ...". The same goes for the web trigger, if it carries a prompt.
  - (b) The drafter stops returning `asksBefore` and `deliversTo`: drop them from the tool schema and the system prompt and return null. `DraftReview` then never shows a chip that the save cannot keep.
- Whichever path, the review card shows exactly what is saved.

## Check

- `job-logic.test.ts` for (a): a draft with `deliversTo: "#support"` produces a routine input whose prompt contains "#support". For (b): `draft.test.ts` shows the reply's `asksBefore` and `deliversTo` ignored and returned as null.
- `draft-review.test.tsx`: no chip appears for a field that the save drops.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the JB gate review, round 1.
- 2026-11-20: dispatched on task/JB.9-save-keeps-draft-review (v4 controller session).
- 2026-11-20: merged as 64074267, review clean after 0 fix rounds. check, test and build passed on main.
