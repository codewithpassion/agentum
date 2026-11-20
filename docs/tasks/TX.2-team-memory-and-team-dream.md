---
id: TX.2
title: "Team memory and the team dream"
milestone: TX
size: L
status: in_progress
depends_on: [TX.1, DR.4, TM.3]
branch: task/TX.2-team-memory-and-team-dream
lane: services-dream
executor: claude
---

From `docs/v4/build-plan.md`, milestone TX. After the members' dreams, the lead's team reconciles. Design: "The team dream" in `docs/research/ui-reimagine-2026-11/memory-and-dreaming.md`.

## Scope

- Team memory lives in `teams/<slug>/memory/` in the same file format. Member agents load it at run start after their own notes (extend the ME.5 loader through its exported function, not by editing its internals).
- A team dream runs after all member dreams of that night finish or skip. It reads members' notes (only agents with `shareWithTeam`), never `private/` files, and the room's posts since the last team dream.
- Steps: notes that disagree between members become one `dream_question` for the team owner, and the answer updates each member. A note three or more members hold becomes one team note and the copies are forgotten. Repeated hand-off rework between two members becomes a `team_propose_change` proposal from the lead.
- Write a room digest for the catch-up slot from TM.3, and a team diary posted in the room by the lead.
- Undo works for a team dream the same way.

## Check

- Service tests with a fake model: conflict question and both updates, shared fact lifted, private notes untouched, digest stored, undo.
- A team with no lead runs the dream and posts the diary as the system.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: controller decision (from the TX.1 review): a team dream's usage counts toward the workspace's weekly spend and cap, not any one agent's. Record it in the spend rollup as team spend. Migration 0060 is hand-edited; a later migration that rebuilds dream_runs, dream_questions or memory_changes must keep that edit.
- 2026-11-20: dispatched on task/TX.2-team-memory-and-team-dream (v4 controller session).
- 2026-11-21: merge into main conflicted in packages/services/src/dream.ts (after ME.18 landed); aborted and sent back.
