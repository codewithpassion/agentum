# SP.13 review

## Verdicts

Round 1 (c9e4ffe): not clean, 2 must-fix.
- pi-run-core drops the final result when the platform answers 409 for a cancelled run, so most cancelled cloud runs still lose their cost. Out of scope by the task text, recorded below as a follow-up.
- `abortedCompletion` stored usage but did not enforce the cap. Fixed in c5d122a.

Round 2 (c5d122a): clean.

## Nits left

- `completeRun` keeps a redundant `|| result.status === "aborted"` after `completeEndedRun`. It narrows the type for the later status write.
- An aborted completion with usage that reaches an already ended run writes the usage, then `recordProcessEnded` can throw a 409 on a repeat.
- A late report overwrites `usage` each time and re-runs the cap check. There is no once-only guard.
- The machine route test asserts status and `resultText` after a late report, not the stored `usage`. The services tests cover the write.
- No test covers an aborted completion with usage on a run that is already interrupted.

## Beyond the scope

- `apps/web/src/server/pi-run-core.ts` (about lines 448 to 484): on abort the final flush is refused with a 409 and sets `gone`, which skips `completeRun`. Until that changes, a cancelled cloud run's cost still often never reaches `completeRun`. Worth a follow-up task.
- A machine whose lease expired and which then sends its normal `done` with usage now gets a 200 and its usage counts, where it used to get a 409. Its reply text is dropped. The task log note should say machine cancels stay uncounted, but lease interruptions with a late `done` now count.

## Steps for Dom

None.
