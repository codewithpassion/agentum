# W.9 review: runs hang at run.started when the browser leaves

Branch task/W.9-run-start-hang. Final head is recorded in the dispatcher report.

## Cause

A cloud run was claimed (status running, 10-minute lease, `run.started`) inside the browser's `runs.start` request. The request then awaited an RPC to the PiRun Durable Object that takes seconds (VM library sync, agent home). When the browser left, the Worker cancelled the request after the claim. Nothing worked the run, and the lease reaper ended it after 10 minutes. Queued runs of the same agent waited behind it. Isolate and Linux VM agents share the path. Managed Agents and machine runs do not claim in dispatch, so they only get delayed. Runs started from the queue run inside the Durable Object, which is why they finished.

## Fix

Dispatch only wakes the PiRun object. The object saves the start, and an alarm claims the run, sets up the environment and starts Pi. A saved start survives an eviction. A claimed run that cannot start within two minutes fails with "The run could not start within 2 minutes: ...". Files: `packages/services/src/cloud/runtime.ts`, `apps/web/src/server/pi-run.ts`, `pi-run-start.ts`, `pi-run-start-alarm.ts`.

The reproduction test is "a request that dies right after the run is accepted does not strand the run" in `packages/services/src/cloud/runtime.test.ts`. It fails on the old dispatch and passes now.

## Verdicts

- Round 1 (e9c7d2e): must-fix. A claim that went through but was not saved was dropped on retry. A hung setup was not covered by the two-minute limit.
- Round 2 (f9901a3): must-fix. A late duplicate wake for a running run counted as claimed.
- Round 3 (2443503): must-fix. A duplicate wake whose claim failed before D1 still counted a live run as its own.
- Round 4 (9698742): clean. This was a third fix round, added by the controller.

## Nits left

- Two `work()` passes can overlap if the Lifecycle library redispatches a singleflight job after its 30 second hung timeout while a setup runs longer.
- A concurrent attempt can remove an entry another attempt is still working, before the claim marker is saved.
- `giveUp` on an unclaimed entry whose claim threw at the deadline leaves the run to the 10-minute lease if the claim did reach D1.
- An eviction between `begin` and `remove` repeats prepare and begin. `runCore.start` de-duplicates, so the cost is a second library sync.
- `waiting` and `claim` calls are not bounded by `withinDeadline`.
- `fail` errors are only logged, and the saved start is then dropped.
- The two-minute limit has a one-second floor, so it is not exact.
- Stale comments about `releaseRun` in `pi-run-core.ts` (`isOver`) and `routes/dev.ts`. `scripts/e2e/cloud.ts` "redispatch" still tests the removed path.
- No tests for `RunStartAlarm`, `PiRun.startRun`, `onStart`, or the `pi-run.ts` claim and `waiting` deps.
- Every wake, including the minute sweep's for runs queued behind another, now costs a call to the object, a storage write and an alarm.

## Beyond scope

- A run whose wake never reaches the object stays offered. The sweep retries every minute, and `UNCLAIMED_EXPIRY_MS` (1 hour) fails it as never claimed. A shorter bound would need a platform-side timer.
- Adding the `durable_object_io_tasks_prevent_eviction` compatibility flag to `wrangler.jsonc` would keep the object alive during long setup.

## Steps for Dom

- Deploy to staging and run the live check: send a message to a Linux VM agent and to an isolate agent, leave the page at once, then return. Both runs should finish and the reply should show.
