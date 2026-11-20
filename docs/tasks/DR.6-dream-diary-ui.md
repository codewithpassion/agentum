---
id: DR.6
title: "Dream diary on the Knows tab"
milestone: DR
size: M
status: in_progress
depends_on: [DR.1, ME.6]
branch: task/DR.6-dream-diary-ui
lane: web-knows
executor: claude
---

From `docs/v4/build-plan.md`, milestone DR. Mockup: the "Last night's dream" card in the report.

## Scope

- `components/agent/room/knows/dream/`: the latest run's diary line and counts, See changes (the list of that run's `memory_changes` with before and after from library versions), Undo this night, and a list of earlier dreams.
- Dream schedule control (Nightly, Weekly, Off) and a "Dream now" button for the owner and admins.
- A `dream_question` item renders in the Needs you pane (`components/rail-pane/`) with its two notes and a button per answer.

## Check

- Component tests for the card states: none yet, skipped, done with a question, undone.
- Browser: Dream now with the fake model, read the diary, undo, answer a question.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/DR.6-dream-diary-ui (v4 controller session).
