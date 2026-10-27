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

- Round 1 (4199a92): clean.

## Nits left

- `offerAgainIfFree` also runs when no run of the agent is live, so a Slack message with files offers its run twice. The repeat start is ignored by PiRun but costs a `startRunner` call.
- `offerAgainIfFree` can throw on a DB error after a successful download, where `offerNextWaiting` logs and swallows.
- Its live-run query filters on agent only, not workspace.
- When several runs expire in one batch, failing the first offers the second, which the loop then fails.
- `offeringRuns` in the test file is not used by the two older tests that repeat its setup.

## Ideas beyond the scope

- Re-offer a dropped start from the PiRun itself when its claim is refused, with a short retry.

## Steps for Dom

None.
