---
id: W.10
title: Slow cold run start and run order per agent
milestone: W
size: M
status: blocked
depends_on: [W.9]
branch: task/W.10-run-start-latency
---

Backlog: Dom on 18 Oct 2026 said to leave this for now. Blocked so it isn't dispatched.

Found in the W.9 staging check on 18 Oct 2026 (log in `/home/roboto/devel/harbourmaster-wt/tmp/W9-check/log.txt`):
- A cold run on an isolate or Linux VM agent showed "queued" for 60 to 110 s, then went straight to done. One word took about 66 s on the isolate.
- A run posted 0.4 s after another one on the same agent (run 01M56GPRMQXTQ6051JWJCNBFP7 in a warm session) finished before the earlier run in a new session, although only one run per agent may be running (`packages/services/src/runs.ts:644`).

## Scope

- Measure the time from send to the first event on main before and after the W.9 merge, so we know whether W.9 caused the delay. Then find where the time goes (alarm scheduling, DO wake-up, claim, container start) and cut it.
- Runs of one agent start in the order they were created.

## Check

- A test for start order across two sessions of one agent.
- Live on staging (controller): a cold isolate run shows its first event within 10 s of Send.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-18: added at Dom's request, backlog.
