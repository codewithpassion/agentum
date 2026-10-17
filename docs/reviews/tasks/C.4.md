# C.4 review

Task: Lease, heartbeat and run token for cloud runs. Branch task/C.4-cloud-lease.

## Verdicts

- Round 1 (fd8c217): clean, 0 must-fix, 12 nits. No fix rounds.

The reviewer ran `bun run check`, `bun run test`, `bun run build` and the `drizzle` bundle grep, and they pass. After the review the dispatcher fixed nits 11 and 12 (the script's default log directory, the `heartbeatRun` comment) and re-ran the checks.

## What changed

The rule for outages over the 90 s lease is a longer lease for cloud runs. `CLOUD_LEASE_MS` (10 minutes, `@repo/services/cloud/lease`) is what `claimRun` and `heartbeatRun` set when the system principal passes `{ leaseMs }`. The cloud runtime claims with it and `PiRun` heartbeats with it. A run token is valid while the lease is, so the same rule keeps the token valid, and the reaper needs no change. An outage of the object over 10 minutes still ends the run `interrupted`.

Rejected: a reaper skip (the reaper cannot tell a cloud run from a fake-runtime run, both are claimed by `system`, so a dead run would stay `running` forever, and the token would die with the lease anyway) and a Durable Object liveness check (it runs inside the Worker, and the outage test takes the dev server down, so the sweep could not ask).

The heartbeat is a Lifecycle job, `RunLeaseAlarm` in `pi-run-lease.ts`. It shares the one physical alarm with PiHarness's wake job, survives an eviction and wakes the object. `startRun` and `onStart` schedule it, and it repeats every 20 s while any run is active. Each beat (`beat` in `pi-run-core.ts`) heartbeats every active run younger than the run token's 12 hours and works again any active run the object is not following. That is the wake C.3 nit 2 left to C.4. The in-process interval is gone (C.3 nit 7). A heartbeat that the platform refuses with `conflict` stays quiet, as before, for the run that was released and offered again (C.2 nit 11).

## Checks

- `bun run check`, `bun run test` and `bun run build` pass. The `drizzle` grep on `apps/web/dist/client` finds nothing.
- The kill test, `bun scripts/e2e/cloud-outage.ts --port 3917` against `vite dev`: the faux model streams for about 30 s, the script kills the dev server's process group at 6 s, runs the lease sweep (`reapExpiredLeases`) every 20 s for 120 s while the server is down, then starts the server again. All five assertions pass: the run stays `running` with a future lease through the outage, ends `done` with its result, the tool call after the restart (`slow-bash`, a library `bash` call through `/mcp` with the run token) succeeds, and the lease moves forward after the restart. With `CLOUD_LEASE_MS` set to 90 s the same script fails with "the lease reaper interrupted run ... 100 s in", so the test exercises the rule.
- Bun tests: lease option, outage and reaper in `runs.test.ts`; the cloud claim and token in `cloud/runtime.test.ts`; `beat` in `pi-run-core.test.ts`; `runOutage` with fakes in `scripts/e2e/cloud-outage.test.ts`.

## Nits left

1. `beat` swallows a `conflict` from the heartbeat and never asks whether the run is over. If `pi.wait` never resolves, the run stays followed, the beat does not work it again, and the alarm wakes the object every 20 s for as long as the run is `active` in the object. The platform reaps the run 10 minutes after the last heartbeat that landed. On a conflict, `isOver` then abort and `finishRun` would close it.
2. A run whose work keeps failing for a reason other than a conflict is still heartbeated, up to the 12 hour token age. Before C.4 the lease lapsed within 90 s of the object being evicted.
3. `startedAt` is set at the first start only, so a released and claimed again run keeps counting from it. A run saved before C.4 has no `startedAt` and is heartbeated without the 12 hour limit.
4. In `schedule`, `Math.min(pending.time, due)` takes the time of a beat that is running right now, so a second beat fires straight after the first. Using `due` alone would remove the extra beat.
5. Whether alarm invocations can overlap (a deadman or a platform re-fire) is not settled from the dist code. If they can, a first beat that ends with "no active runs" could delete the row of a second beat that was pushed meanwhile.
6. The job has the default 30 s hung timeout. After an eviction the first beat opens the harness inside `resumeRun`. If that takes over 30 s the driver treats the job as hung and may run a second beat next to it.
7. `startRun` schedules the alarm after `start()` resolves. If `pi.submit` throws after the run was saved as active, no beat is scheduled by that call (a later start does it).
8. `onStart` schedules a beat on every wake, even with no active run, so each wake costs one empty beat 20 s later. If `resume()` throws, `schedule()` is skipped.
9. A run whose completion answered "waiting" is worked again every 20 s until the sweep offers it again. Each pass re-sends the slice and retries the completion three times.
10. No bun test covers `RunLeaseAlarm` (the `schedule` timing, the job outcomes). Only the live script does.
11. Fixed: the script's default log directory is under the OS temp directory.
12. Fixed: the `heartbeatRun` comment.

## Ideas beyond the scope

- Nits 1 and 2 are one change: a beat that finishes a run the platform has ended, and that stops heartbeating a run whose work has failed several beats in a row.
- A `bun test` that loads `PiRun` and `RunLeaseAlarm` under the `cloudflare:workers` shim (C.3 had the same idea).
- The kill test could join the C.9 durability suite.

## Steps for Dom

None for accounts or dashboards in this task. For the controller's staging deploy: no new binding and no new Durable Object class, so the deploy path from C.3 is unchanged. The live kill test needs `PUBLIC_BASE_URL=http://localhost:<port>` in `apps/web/.env.local` (the script says so and checks), because the Worker reads that variable from `.env.local` and not from the process environment.
