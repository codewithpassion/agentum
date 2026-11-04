---
id: DT.2
title: Dictation in the remaining prompt boxes
milestone: DT
size: S
status: todo
depends_on: [DT.1]
branch: task/DT.2-dictation-rollout
lane: web
executor: codex
---

Spec: `docs/v3/dictation.md`, "Boxes", DT.2 list.

## Scope
- Add the DT.1 component to each DT.2 box, with no change to the module unless a box needs a new adapter.

## Check
- Each box has a test that it renders the mic and inserts dictated text.
- `bun run check && bun run test && bun run build`.

## Log
