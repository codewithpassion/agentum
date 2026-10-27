# N.3 review: nits in run start order (W.10)

Branch task/N.3-run-order-nits.

## Changes

- `packages/services/src/runs.ts`: `fetchPendingFiles` calls `offerAgainIfFree` after it offers a run whose files landed. If the run is still waiting and the agent has no live run, it offers the agent's next run again, so a download that lands while a live run ends no longer waits for the sweep. `expireUnclaimedRuns` calls `offerNextWaiting` after it fails a run.
- `packages/services/src/runs.test.ts`: tests for the oldest run still downloading (no offer), the third failed download (offers the next run), a download landing as a live run ends (offered again), a download behind a live run (offered once) and an expired run (offers the next).

## Rule for a run with pending downloads

A run with pending files is not claimable, and a younger run of the same agent waits for it, in any session. Kept as is. The agent runs one run at a time, so letting younger runs of other sessions overtake would break creation order for no gain in throughput. The hold is short: a download that fails is tried at most three times, then the run fails and the next run is offered. Narrowing it to the run's own session would need the same exception in `claimRun`, the machine claim and `offerNextWaiting`, and the order would stop being per agent.

## Accepted, not changed

- Monotonic ids order runs only inside one isolate. Two isolates in the same millisecond still tie-break at random.
- The reaper offers the next run at once, though a lost heartbeat does not prove the process stopped.

## Verdicts

(filled per round below)

## Ideas beyond the scope

- Re-offer a dropped start from the PiRun itself when its claim is refused, with a short retry.

## Steps for Dom

None.
