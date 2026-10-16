---
id: C.8
title: Execution environment for cloud agents
milestone: C
size: L
status: todo
depends_on: [C.7]
branch: task/C.8-cloud-exec-env
---

From the C.0 spike (`docs/reviews/spike-pi-durable.md`, "Proposed tasks" and the findings above it). Dom said go on all Cloudflare agent tasks on 17 Oct 2026. Read the spike report first. The prototype is in `/home/roboto/devel/harbourmaster-wt/tmp/spike-pi-durable/`, read-only, and code can be lifted from it.

## Scope

A just-bash backed `ExecutionEnv`, so Pi's built-in `read`, `write` and `edit` tools work on the workspace library. A Sandbox-backed shell is out of scope here. Note it in the review file as a follow-up.

## Check

Pi's built-in `read` and `edit` change a library file, and the change shows on `/library`. `bun run check && bun run test && bun run build` pass, and the bundle grep for `drizzle` passes.

## Log
- 2026-10-17: added from the C.0 spike (Dom: go on all).
