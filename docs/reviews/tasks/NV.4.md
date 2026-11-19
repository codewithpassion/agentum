# NV.4 review: a waiting question no longer holds the machine lane

## Verdict per round

- Round 1, b916388: must-fix. The parked turn's reply was never delivered, the follow-up's input was not masked, and the server did not re-check the deferral rule at park.
- Fix 1, 4cb0282: must-fix. An app-triggered run could park, so the app got two `finished` replies.
- Fix 2, 738fb35: must-fix. A run with an `a2a` reply could defer, which completed the peer's task with the question text.
- Fix 3, 483e0e6: must-fix. Two racing `complete` calls both delivered the reply.
- Fix 4, 59fb861: must-fix. The park wrote in two statements outside `atomic`.
- Fix 5, 16d7567: clean.

Fix rounds: 5.

## What shipped

A new daemon feature, `parked-questions`. A claim carries `questionsLater` only for a daemon that names it and `requests`. For a question on a plain machine run the open response carries `deferred: true`. The daemon then denies the `AskUserQuestion` call with a "the answer arrives later, end your turn" reason and completes `done` with `awaitingAnswer: true`. A repeat question after that is denied at once.

The deferral rule lives in `runs/deferral.ts` and is used when the question opens and when the turn parks. A run defers only when it is machine-claimed, not a dry run, not an `app` or `a2a` reply, not artifact-scoped, has no parent, is not a subagent, has no peer root, and is not in an artifact session. Everything else keeps the synchronous wait.

The server parks the run in one `atomic` write: status `waiting`, no lease, no `run.finished`. Only the call whose write applied delivers the turn's reply and wakes the listeners. The reaper skips a parked run, `markRunning` and `heartbeatRun` refuse it, and the machine claim no longer counts it as holding the agent's lane or its session. When the last open question closes (web or Slack answer, expiry, a person withdrawing it), `settleParkedRun` ends the run with one conditional write. One follow-up run then starts in the same session. It takes the parked run's actor, depth and delegation (`continuationOf`), has request id `question-answer:<runId>`, resumes the stored Claude session, and carries the answers as input with the agent's granted secret values masked. An answer that lands before the turn ends is handled in either order.

## Nits left

- `parkIfAsking`'s early `isParked` check uses the run as loaded at the start, and the `run.waiting` event check has the same staleness in a race. Both are harmless.
- If `startRun` throws after the parked run has ended (agent archived, D1 error), the answers are only logged and nothing retries.
- If a parked-listener throws, the run stays parked with no pending question and nothing ends it.
- `continueParked` uses an `as Parameters<...>` assertion, like the hand-off wake code.
- The route calls `open` and then `defersQuestion` (two service calls). `open` could return `deferred` itself.
- The system claim and the managed claim still count any `waiting` sibling, so a dry run or a cloud run in the same session waits behind a parked run. Library-change frames and the session queue banner also still count a parked run as live.
- `finishedAt` is set when the run is settled, so its duration includes the whole parked wait.
- The follow-up's `message.user` event is attributed to the parked run's actor, so another member's answer reads as the original person's message.
- An agent that keeps asking with nobody answering starts one run per 24 hours. Depth does not grow, by design.
- The "local run with the fake runtime" check is covered by `requests-parked.test.ts` (ask, a second task claimed while the first waits, answer, one follow-up that resumes the session). The fake runtime only echoes and never asks, so no browser run was made.

## Ideas beyond scope

- Show a parked run as "waiting for an answer" on the Roster from its pending request.
- Retry a follow-up that failed to start, from the minute tick.

## Steps for Dom

- Deploy the Worker before the daemon. The strict `complete` schema of an older Worker rejects `awaitingAnswer`. A new daemon never sends it to a Worker that does not send `questionsLater`, and an old daemon ignores `deferred`, so mixed versions keep the old wait.
- `apps/web` `guest-execution.test.ts` fails on main too (a workerd fetch failure in this environment) and sometimes passes. It is not caused by this branch.
