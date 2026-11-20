---
id: DR.15
title: "Undo reads in the safe order and closes the run's questions"
milestone: DR
size: S
status: in_progress
depends_on: []
branch: task/DR.15-undo-safe-order-and-open-questions
lane: services-dream
executor: claude
---

From the DR gate review, round 1 (`docs/reviews/DR-1.md`, nits 1 and 10). The gate was clean, but nit 1 can silently drop a person's note, so it gets its own task.

## Scope

- In `dream/undo.ts`, load the memory files and their etags first and check the version ids after, the way `decide` does, so a person's write that lands in between is never overwritten.
- Undo closes the run's open dream questions. Rejecting a held batch closes the questions that name its held notes.

## Check

- A test that writes a person's note between undo's two reads: the note survives and undo reports the conflict.
- Tests: after undo, the run has no open question; after a reject, questions naming held notes are closed and others stay open.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-21: added from the DR gate review, round 1.
- 2026-11-21: dispatched on task/DR.15-undo-safe-order-and-open-questions (v4 controller session).
