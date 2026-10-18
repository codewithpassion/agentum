---
id: W.9
title: Runs hang at run.started when the browser leaves the chat page
milestone: W
size: M
status: done
depends_on: []
branch: task/W.9-run-start-hang
---

Found in the W.7 staging check on 18 Oct 2026 (notes in `/home/roboto/devel/harbourmaster-wt/tmp/W-check2/`). Three runs (XBG16Q02, S8Z8S4R4, 4PG75Y7X, on Linux VM agent w-check-vm2) stayed at `run.started` with no `tool.call` until `run.interrupted` at lease expiry, about 10 minutes later. Queued runs of the same agent waited behind them (one running run per agent, `packages/services/src/runs.ts:644`). In all three, the browser navigated away from the chat page within a second of Send. Runs where the page stayed open, and runs started from the queue, completed. The cause is not confirmed in code.

## Scope

- Find where run start depends on the client: for example, work started inside the request or stream that the browser opened, and cancelled when it disconnects, instead of in the Durable Object, `waitUntil` or a queue. Check the Cloudflare isolate and Linux VM paths, and whether Managed Agents and machine runs share the cause.
- Fix it so a run, once accepted, starts and finishes whether or not any client stays connected. A client that reconnects still sees the live events.
- If a run still can't start, it fails within a short, stated time with a clear error, not after the 10-minute lease.
- Write a failing test first that reproduces the disconnect (abort the request right after the run is accepted), then fix.

## Check

- The reproduction test fails before the fix and passes after.
- Live on staging (controller): send a message on a Linux VM agent and an isolate agent, and leave the page at once. Both runs finish, and the reply shows when you come back.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-18: added at Dom's request. dispatched.
- 2026-10-18: review clean after 3 fix rounds at e154ad0 (docs/reviews/tasks/W.9.md); third round approved by the controller. Cause: the cloud run was claimed inside the browser's runs.start request before the slow PiRun DO call; dispatch now only wakes the DO, and an alarm claims and starts the run. Merged. Staging check pending.
