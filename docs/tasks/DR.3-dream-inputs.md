---
id: DR.3
title: "Dream inputs: what happened since the last dream"
milestone: DR
size: M
status: done
depends_on: [DR.1]
branch: task/DR.3-dream-inputs
lane: services-dream-inputs
executor: codex
---

From `docs/v4/build-plan.md`, milestone DR. Collect the evidence a dream reads. File: `packages/services/src/dream/collect.ts`.

## Scope

- `collectSince(agentId, since)` returns, in time order: conversation messages and task results from `sessions` and `runs`, requests with their answers from `run_requests` (mark denied approvals), edit-and-resend events, failed and interrupted runs, `memory_changes` written by the agent, and rejected skill and memory proposals.
- Tag each item with its source id and whether it came from a private session or from outside (mail from outside, A2A peer).
- Cap the result at a character budget, newest first, and report what was left out.
- Read through the existing services with a system principal for that workspace. No new tables.

## Check

- Tests: each item kind, private and outside tags, the cap, an empty window.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/DR.3-dream-inputs (v4 controller session).
- 2026-11-20: merged as 7f50c0e7, review clean after 2 fix rounds. check, test and build passed on main.
