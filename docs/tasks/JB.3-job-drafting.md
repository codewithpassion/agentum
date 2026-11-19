---
id: JB.3
title: "Describe a job, get a draft"
milestone: JB
size: M
status: todo
depends_on: [JB.1]
branch: null
lane: builder
executor: codex
---

From `docs/v4/build-plan.md`, milestone JB. A person types "Every Friday, summarise support tickets for me" and reviews a draft.

## Scope

- Fill `jobs.draft`. Reuse the model call and prompt style of `packages/services/src/agent-builder/draft.ts`. Output: a routine (cron, timezone from the workspace, prompt) or a mail or http trigger.
- The draft is never saved by this call. Saving goes through the existing `routines` and `triggers` services.
- Reject text that names no time or event with a message that asks for one.

## Check

- Tests with a fake model: three phrasings to three drafts, and the rejection case.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
