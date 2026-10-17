---
id: C.4
title: Lease, heartbeat and run token for cloud runs
milestone: C
size: M
status: in_progress
depends_on: [C.3]
branch: task/C.4-cloud-lease
---

From the C.0 spike (`docs/reviews/spike-pi-durable.md`, "Proposed tasks" and the findings above it). Dom said go on all Cloudflare agent tasks on 17 Oct 2026. Read the spike report first. The prototype is in `/home/roboto/devel/harbourmaster-wt/tmp/spike-pi-durable/`, read-only, and code can be lifted from it.

## Scope

Heartbeat from an alarm owned by the runtime, plus a rule for outages longer than the 90 s lease (a longer lease, a reaper skip, or a Durable Object liveness check). The rule must keep the run token valid too, since tokens die with the lease.

## Check

Kill test with the sweep running: the object is down for 120 s, the run ends `done` and not `interrupted`, and tool calls after recovery succeed. `bun run check && bun run test && bun run build` pass, and the bundle grep for `drizzle` passes.

## Log
- 2026-10-17: added from the C.0 spike (Dom: go on all).
- 2026-10-17: dispatched on task/C.4-cloud-lease.
