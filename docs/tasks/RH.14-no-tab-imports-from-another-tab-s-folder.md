---
id: RH.14
title: "No tab imports from another tab's folder"
milestone: RH
size: S
status: todo
depends_on: []
branch: null
lane: web-agent
executor: claude
---

From the RH gate review, round 1 (`docs/reviews/RH-1.md`, must-fix 3).

## Scope
- Move `canManageAgentKeys`, with its test, out of `components/agent/room/keys/keys-logic.ts` into a file under `components/agent/` outside the tab folders, for example `components/agent/agent-rights.ts`. Import it from there in both the Keys and Settings tabs.
- Add a test that no file under `components/agent/room/<tab>/` imports from another tab's folder. `now/` may import from `knows/`, as the RH.5 log allows.

## Check
- The new import test fails on this commit and passes after the move.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the RH gate review, round 1.
