---
id: SP.12
title: "Managed runs record their usage"
milestone: SP
size: S
status: todo
depends_on: []
branch: null
lane: runtimes
executor: claude
---

From the SP gate review, round 1 (`docs/reviews/SP-1.md`, must-fix 2).

## Scope

every managed completion passes `usage`, with input and output tokens and `costUsd`, read from what the managed session reports. That covers a run that ends done, one that fails, and the `failRun` and `endFailed` paths. If the API reports tokens and no cost, price them from the model's rates in one shared place that the other runtimes can reuse, never in a second price table. `enforceCap` then runs through the normal `completeRun` path. If the managed API reports no usage at all, record that in the task log. The agent's Settings cap field then says that spend is not tracked for this runtime, so an owner is not misled by a cap that can never fire.

## Check

a managed service test where the fake session reports usage, and the finished run's `usage.costUsd` is set. A cap test where a managed agent at $0.99 of a $1 cap finishes a run that costs $0.02 and ends paused with reason `spend_cap`. `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-21: added from the SP gate review, round 1.
