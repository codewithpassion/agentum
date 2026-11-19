---
id: FR.2
title: "Team starter: a lead and three specialists"
milestone: FR
size: S
status: todo
depends_on: [FR.1, TM.4]
branch: null
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
