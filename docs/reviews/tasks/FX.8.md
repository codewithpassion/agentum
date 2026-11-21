# FX.8 review

## Result

The ArtifactRoom test did not hang. Run alone with the skip removed, under `timeout 300`, it passed six times in a row at 52 to 68 s, inside its 120 s timeout. FX.1's runner fixes were already in the code FX.7 ran, so the cause of FX.7's 20-minute run is unknown. The likeliest reading is a loaded machine, since the other workerd tests in this repo show the same pattern.

The test is back on and its line is gone from `docs/backlog/flaky-tests.md`. Two hardening changes keep a future hang from stalling a run: Bun kills the node runner at 100 s, under the 120 s test timeout, and the runner's socket open wait has a 15 s deadline.

No product code was involved, so there is no finding to report.

## Rounds

- Round 1, at 6bc58f86: not clean. The commit message wrongly credited FX.1, and nothing guarded against a stuck runner. Fixed in 2d9418cd.
- Round 2, on 2d9418cd: clean.

## Nits left

- `fixtures/runner.mjs` "atomic concurrent consume": it counts sockets that got 101, so a second socket that times out with 408 passes where it should be a 403.
- `fixtures/runner.mjs` connect: the 408 timer is unref'd but never cleared.
- `room.test.ts`: a killed runner leaves empty stdout and no word that it timed out.
- A SIGTERM from the 100 s kill skips the runner's `finally`, so one `artifact-room-*` temp directory stays behind. workerd is still killed.

## Ideas beyond scope

If the test hangs again, run the runner by hand with the 15 s deadline in place and read which check fails.

## Steps for Dom

None.

## Browser steps skipped

The task has none.
