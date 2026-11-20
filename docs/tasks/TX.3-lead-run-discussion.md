---
id: TX.3
title: "Lead-run discussion rounds"
milestone: TX
size: M
status: in_progress
depends_on: [TX.1, TM.4]
branch: task/TX.3-lead-run-discussion
lane: services-inbox
executor: codex
---

From `docs/v4/build-plan.md`, milestone TX. From the transcript: "drive a three round discussion". The loop guard stops wakes after three agent posts in a row, so a discussion needs its own budget.

## Scope

- Tool `team_discussion(topic, question, rounds)` for a lead, rounds 1 to 5. It creates a `discussions` row and posts the question.
- Each round wakes every topic member once. A member posts once per round. When all have posted or ten minutes pass, the lead is woken to open the next round or close.
- Inside a running discussion, `loop-guard.ts` allows these wakes and counts them against the discussion's budget: rounds times members. Outside it, the guard is unchanged. The hourly wake limit per agent still applies.
- A person can stop a discussion from the room.

## Check

- Tests: three rounds with three members makes nine member wakes and no more, a silent member does not stall a round, stop works, the guard outside a discussion is unchanged.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-21: dispatched on task/TX.3-lead-run-discussion (v4 controller session).
- 2026-11-21: merge conflicted in packages/services/src/inbox.ts (after TX.2 landed); aborted and sent back.
