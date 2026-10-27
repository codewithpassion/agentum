# W.10 review: slow cold run start and run order per agent

Branch task/W.10-run-start-latency.

## Scope against current main

- Run order per agent: not fixed on main. `claimRun` and the machine claim only checked for an older waiting run in the same session, so a run in a newer session of the same agent could start first. Fixed: both now refuse a run while an older run of the same agent, in any session, is `queued` or `offered`. The Managed Agents claim stays per session, because it lets one run per session work, not one per agent.
- Queued-run cut-off (V1.17): already fixed on main. A run behind a live run is no longer failed "Never claimed" after an hour.
- Cold start "queued" for 60 to 110 s: the strand in the browser request (W.9) is already fixed on main. Not measured: the dispatcher cannot deploy or reach staging.

## Likely cause of the long "queued", from the code

A cloud run (isolate or Linux VM) claims from the PiRun alarm. When the claim is refused because another run of the agent is live or older, the start is dropped (`pi-run-start.ts`) and the run waits to be offered again. The cloud runtime offers the agent's next run when a run ends through complete, fail, cancel or a repeat stop. Two ends did not: the lease reaper and a run failed by its third file-download failure. Then the run waited for the minute sweep, which only offers runs stale for 60 s, so 60 to 120 s. That matches the 60 to 110 s seen. Both ends now offer the next run.

## Changes

- `packages/services/src/runs.ts`: agent-wide order in `claimRun`; `reapExpiredLeases` and the third download failure call `offerNextWaiting`; `offerNextWaiting` offers nothing while the agent's oldest waiting run is still downloading (a younger run would be refused); run ids come from `monotonicFactory`, so runs created in one millisecond keep creation order.
- `packages/services/src/runs/machine-claim.ts`: agent-wide order.
- Tests: a newer run in another session waits for the agent's older run (`runs.test.ts`, `machine-claim.test.ts`, both fail on the old code); reaping offers the next run. Four existing tests queued an older run on the same agent and now cancel it, use another agent or advance the clock.

## Verdicts

- Round 1 (91049f9): not clean. A test turned flaky because same-millisecond run ids sorted randomly. The cold-start half had no measurement.
- Round 2 (6ea150b, fix commit only): clean. Monotonic ids and the two `offerNextWaiting` changes were checked.

## Nits left

- No test for "oldest run still downloading blocks the offer" or "third failed download offers the next run".
- Monotonic ids order runs only inside one isolate. Two isolates in the same millisecond still tie-break at random.
- A download that lands while a live run is ending can be offered before the claim is free, then waits for the sweep.
- A run with pending files now holds back every session of its agent, not only its own, until it downloads or fails.
- The reaper offers the next run at once, though a lost heartbeat does not prove the process stopped (as before, only sooner than the sweep).
- The `expireUnclaimedRuns` sweep does not call `offerNextWaiting`; the same tick's stale offer covers it.

## Ideas beyond the scope

- Re-offer the dropped start from the PiRun itself when a claim is refused, with a short retry, so a refused claim never waits for the sweep.
- Shorten `STALE_QUEUE_MS` for cloud runs.

## Steps for Dom

None. The controller's live check: a cold isolate run shows its first event within 10 s of Send. If it does not, the remaining time is the PiRun alarm and `prepare` (VM library sync, agent home), which run after the claim and need a measurement on staging.
