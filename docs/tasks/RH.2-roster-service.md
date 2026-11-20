---
id: RH.2
title: "Roster service: one status line per agent"
milestone: RH
size: M
status: done
depends_on: [RH.1]
branch: task/RH.2-roster-service
lane: services-roster
executor: codex
---

From `docs/v4/build-plan.md`, milestone RH. The home page shows what each agent is doing now. This task fills `roster.list` from data that already exists.

## Scope

- State by precedence: `needs_you` when an open request or Needs you item names the agent's owner or backup (reuse `rail/logic.ts`), `stopped` for a failed or interrupted last run or an archived machine, `working` for a running run, otherwise `idle`.
- Status line: the waiting item's heading, or the running task's title, or "Idle. Next run <time>" from the agent's next routine (`routines/cron.ts`), or "Idle".
- Job line: the first sentence of `instructions`, 80 characters at most.
- Cost this week from `runs.usage`. Read how `apps/web/src/components/agent/agents-table-logic.ts` sums it and compute the same number in the service. Leave the web file alone, it is outside this lane.
- One query plan for the whole list. No query per agent. Call `authorize()` first.

## Check

- Service tests: one per state, precedence when two apply, next-run text, cost sum, 50 agents in a bounded number of queries.
- Visibility test: a member sees the same agents `/agents` shows.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/RH.2-roster-service (v4 controller session).
- 2026-11-20: merged as 306a6511, review clean after 1 fix round. check, test and build passed on main.
