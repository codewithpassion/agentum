# TX.8 review: a refused hand-off wake is retried

## Rounds
1. 99e7c94c: must-fix. Two refused requests in one thread: the retry for the oldest counted as the answer to the newer one. A non-budget refusal recorded a stop event on every tick.
2. debb54c1: must-fix (test only). The "refusal that is not the budget" test never reached `wakeOne`.
3. 4bab41c1: clean.

## What changed
A new `dream.retryHandOffs` tick job (`dream/team/hand-off-retry.ts`) finds hand-off requests in each live team's Team diary topic from the last 24 hours. For the newest request per team it calls `inbox.retryNoticeWake`, which wakes the lead when it has no run in the thread since the post. A retry that is refused records no `inbox.loop_stopped` event. The dream's diary line now reads "Asked the lead." and says nothing about the lead working on it.

## Nits left
- `hand-off-retry.ts`: the `noAwaitInLoops` reason and the "in practice includes the older requests" comment are loose. The older requests are missing from the wake input when the lead spoke between two requests or the catch-up limit drops them.
- `inbox-notice.test.ts`: `runs = real` is not restored in a `finally`. `build()` resets it per test.
- Each tick re-reads the last 24 hours of hand-off posts per team, newest only, with a few queries each.

## Ideas beyond scope
- Stop the retry once the lead has answered, with a stored marker, instead of re-checking each tick.

## Browser steps skipped
"Browser: the lead answers in Team diary" is skipped. Dom moved browser checks to one pass at the end of v4.

## Steps for Dom
None.
