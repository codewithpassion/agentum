---
id: RH.12
title: "A live run never reads Idle on a card"
milestone: RH
size: S
status: todo
depends_on: []
branch: null
lane: services-roster
executor: claude
---

From the RH gate review, round 1 (`docs/reviews/RH-1.md`, must-fix 1).

## Decision

Controller decision (20 Nov 2026): follow the RH.2 task file. `needs_you` means an open request that names the agent's owner or backup, the same on everyone's card, within the private-session rules.

## Scope
- In `packages/services/src/roster.ts`, decide first what keys `needs_you`. The task file says an open request that names the agent's owner or backup. The code says a request in the viewer's own Needs you list. Record the choice in RH.2's log.
- If it follows the task file, ask the rail for every item the viewer may see (the "everyone" scope, which keeps the private-session rules) and take the wait for each agent from that.
- Whatever the choice, a `waiting` run that has no visible wait shows as `needs_you` with a plain line such as "Waiting on Ann". A `queued` or `offered` run shows as `working` with a line such as "Queued" or "Starting". Neither reads "Idle".

## Check
- A service test builds the real rail service, not the mock, with two members. Agent owned by A, a question open on its run, B lists the roster: B's card is not "Idle", and its state follows the recorded choice.
- Service tests: a `queued` run and an `offered` run each give `working`.
- The existing precedence tests still pass.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the RH gate review, round 1.
