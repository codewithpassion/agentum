---
id: LR.16
title: All deck controls 40px at 390px; private artifact with a user grant opens
milestone: LR
size: S
status: in_progress
depends_on: [LR.12]
branch: task/LR.16-deck-controls-grant-page
lane: web
executor: claude
---

LR.7 round 4 (`docs/reviews/tasks/LR.7.md`).

## Scope
- At 390px, 24 of 56 deck controls are 33-35px; all must be at least 40px. `deck-editor.css:361` covers only `.ld-toolbar`; also `deck-editor.tsx:252-272` and `:652-660`, `inspector.tsx:112`. Desktop unchanged.
- A private artifact with a user grant shows "not available" on its page for the granted user (`routes/a.$artifactId.tsx:53`). The granted user must see it; others still must not.

## Check
- Browser measurement at 390x844: 0 deck controls under 40px; desktop layout unchanged.
- Tests: granted user opens a private artifact page; ungranted member and signed-out users don't.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-29: created from LR.7 round 4; dispatched.
