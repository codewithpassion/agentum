---
id: FR.2
title: "Team starter: a lead and three specialists"
milestone: FR
size: S
status: in_progress
depends_on: [FR.1, TM.4]
branch: task/FR.2-team-starter
lane: builder
executor: codex
---

From `docs/v4/build-plan.md`, milestone FR. From the 18 Nov analysis, item 8.

## Scope

- Two team starters built from the agent templates: Sales (lead, lead research, outreach drafts, CRM tidy) and Back office (lead, invoice filing, shared drive tidy, weekly report). Each has team rules text.
- `builder.teamFromStarter(key)` returns a draft team for review and creates the team, its members and its lead on confirm, in one `atomic` call.
- Tool rule in each starter: no member edits its own skill.

## Check

- Tests: draft and create for both starters, nothing is created when one member fails validation.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/FR.2-team-starter (v4 controller session).
- 2026-11-21: merge check failed typecheck (team-starters.ts calls the teams service with deps that no longer match TeamsDeps on main); merge undone and sent back.
- 2026-11-21: merge conflicted in apps/web/src/server/compose.ts after SL.4 landed; aborted and sent back.
