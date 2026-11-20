---
id: JB.3
title: "Describe a job, get a draft"
milestone: JB
size: M
status: in_progress
depends_on: [JB.1]
branch: task/JB.3-job-drafting
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
- 2026-11-20: dispatched on task/JB.3-job-drafting (v4 controller session).
- 2026-11-20: merge into main conflicted in compose.ts and packages/services/src/jobs.ts (after JB.2 and KY.3 landed); aborted and sent back to the dispatcher.
