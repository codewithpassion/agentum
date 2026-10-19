---
id: P.6
title: Real cost from OpenRouter
milestone: P
size: S
status: done
depends_on: [P.4]
branch: task/P.6-openrouter-real-cost
---

Asked for by Dom on 19 Oct 2026, from the report `docs/analysis/other-model-providers.md` (section D, "Cost and usage logging"). Pi computes `costUsd` from the catalogue's per-million prices, so it is an estimate that goes stale, and OpenRouter's real cost depends on which provider served the request. Every OpenRouter response carries `usage.cost`, in the last chunk when streaming. Store that per run.

## Scope

- Read `usage.cost` from the OpenRouter response (through `onResponse` or the final chunk, whichever Pi exposes) and store it as `costUsd` in `runs.usage` when present. Fall back to Pi's catalogue estimate when it is absent.
- Anthropic runs are unchanged.
- Never log the key or the raw response body.

## Check

- The fake-server test from P.4 returns a `usage.cost` and the run's usage holds that value. A second case without `usage.cost` keeps Pi's estimate.
- Live on staging (controller): one GLM-5.3 run's stored `costUsd` matches the cost on OpenRouter's activity page for that request.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-19: added at Dom's request.
- 2026-10-19: dispatched.
- 2026-10-19: review clean after 0 fix rounds at b7bd222 (docs/reviews/tasks/P.6.md). Merged. Staging check pending (compare costUsd with OpenRouter activity).
