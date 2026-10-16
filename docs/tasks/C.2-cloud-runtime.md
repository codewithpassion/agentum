---
id: C.2
title: CloudRuntime adapter
milestone: C
size: M
status: todo
depends_on: [C.1, M8.1]
branch: task/C.2-cloud-runtime
---

From the C.0 spike (`docs/reviews/spike-pi-durable.md`, "Proposed tasks" and the findings above it). Dom said go on all Cloudflare agent tasks on 17 Oct 2026. Read the spike report first. The prototype is in `/home/roboto/devel/harbourmaster-wt/tmp/spike-pi-durable/`, read-only, and code can be lifted from it.

## Scope

Add `cloud` to `AGENT_RUNTIMES`, next to the `managed` runtime that M8.1 adds. Extend `claimRun` with the agent-busy and older-run checks, release the claim when a start fails, and add a `CloudRunnerPort`. Add the cloud option to the agent form. Where cloud agents can't do something (shell, local files, `[ATTACHMENT:path]` until C.7), the form says so.

## Check

Unit tests against a fake runner: dispatch, claim race, a failed start releases the run, cancel. `bun run check && bun run test && bun run build` pass, and the bundle grep for `drizzle` passes.

## Log
- 2026-10-17: added from the C.0 spike (Dom: go on all).
