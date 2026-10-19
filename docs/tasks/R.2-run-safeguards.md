---
id: R.2
title: Run safeguards, turn limit, repeat guard and cancel
milestone: R
size: M
status: done
depends_on: []
branch: task/R.2-run-safeguards
---

Asked for by Dom on 19 Oct 2026, after the P.5 trial (`docs/reviews/trials/P.5-results.md`). A GLM-5.3 Flash run called `run_skill_script` without `args` 128 times in a row and never recovered. Nothing stopped it: runs have no turn limit and no repeat guard, and neither the chat nor the Log can cancel a run. The trial ended it by removing the workspace key.

## Scope

- Turn limit: a run stops after N model turns, default 100, set per agent in its config (between 10 and 500). On the limit the run ends as failed with a clear reason ("Stopped after 100 turns, the agent's limit") and a `run.limit_reached` event. Apply it in the Cloudflare Pi runtime (isolate and Linux VM). For Managed Agents and machines, apply it where the runtime gives us a turn count; where it can't, say so in the review file.
- Repeat guard: 5 identical failed tool calls in a row (same tool, same arguments, each an error) stop the run as failed with the reason and the tool name, and a `run.repeat_stopped` event. Before stopping, on the 3rd repeat, tell the model in the tool result that it is repeating a failing call and must change course.
- Cancel: a Cancel button on a running run in the chat and in the Log, and a `cancel_run` MCP tool for people (refused for runs). Cancelling ends the run as cancelled within a few seconds, records `run.cancelled` with who cancelled, releases the agent so queued runs start, and keeps the transcript so far. Use the existing run lease and status machinery. A cancelled Cloudflare run stops its model call. A Managed run sends Anthropic's interrupt. A machine run tells the daemon at its next poll; the daemon stops Claude Code.
- Show the limit and repeat reasons and the cancel in the Log UI.

## Check

- Tests: a fake model that never stops hits the turn limit; 5 identical failing calls stop the run, 4 don't, and different arguments reset the count; the 3rd repeat adds the warning; cancel ends a running and a queued run, frees the agent, and records who; `cancel_run` is refused for a run principal.
- `bun run check && bun run test && bun run build` pass.
- Live on staging (controller): cancel a running Cloudflare run from the chat and see the next queued run start.

## Log
- 2026-10-19: added at Dom's request. dispatched.
- 2026-10-19: review clean after 2 fix rounds at a2f026b (docs/reviews/tasks/R.2.md). Merged. No turn limit for Managed Agents (no turn count); repeat warning only for cloud runs. Deploy the Worker before daemons. Staging check pending.
