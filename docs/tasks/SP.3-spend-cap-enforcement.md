---
id: SP.3
title: "Caps pause an agent and ask its owner"
milestone: SP
size: M
status: todo
depends_on: [SP.2]
branch: null
lane: services-runs
executor: claude
---

From `docs/v4/build-plan.md`, milestone SP. A cap that only shows a number is not a cap.

## Scope

- When a run finishes and the agent's week-to-date passes `weekly_cap_cents`, set `paused_at` with reason `spend_cap` and raise a `spend_pause` Needs you item for the owner.
- A paused agent starts no new run from any origin (ui, Slack, mail, trigger, routine, A2A, dream). The refusal is a normal result with a plain message, and mail and Slack senders get a reply that says the agent is paused.
- `spend.resume` clears the pause, optionally with a new cap. A running task is never killed by the cap.
- The workspace cap pauses every agent the same way.
- Roster: a paused agent has state `stopped` and the status line "Paused. Weekly limit reached".

## Check

- Service tests: pause on crossing, refusal per origin, resume, workspace cap, a run in flight finishes.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
