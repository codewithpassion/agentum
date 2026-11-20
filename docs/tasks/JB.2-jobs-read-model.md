---
id: JB.2
title: "Jobs read model: every start as a sentence"
milestone: JB
size: M
status: done
depends_on: [JB.1]
branch: task/JB.2-jobs-read-model
lane: services-jobs
executor: codex
---

From `docs/v4/build-plan.md`, milestone JB. Starting work is split over Routines, Triggers, the Starts on sheet, the Map and Channels. One read model lists them all as sentences.

## Scope

- `jobs.forAgent` and `jobs.list` over `triggers` (kinds `http`, `routine`, `mail`, `app`) and `slack_apps`.
- `when`: a cron and timezone become words ("Every Tuesday at 9:00"), an http trigger "When its web address is called", mail "When mail arrives at <address>", Slack "When mentioned in Slack".
- `does`: the routine prompt's first line, or the agent's job line. `asksBefore` from the agent's ask level. Last and next run from `runs` and `routines/cron.ts`.
- `runNow` starts the routine's run once, through the same path the cron uses.

## Check

- Tests: the cron-to-words function over twelve patterns including timezones, one test per source, `runNow` creates one run.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/JB.2-jobs-read-model (v4 controller session).
- 2026-11-20: merged as b5691262, review clean after 1 fix round. check and build passed on main. bun run test passed except guest-execution.test.ts; side-by-side alone runs against the pre-merge commit c48e85d1 failed on both in round 2, so it is the host flake, not JB.2.
