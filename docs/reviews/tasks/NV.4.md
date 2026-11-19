# NV.4 review: a waiting question no longer holds the machine lane

## Verdict per round

Round 1 at b916388: clean, no must-fix. Fix rounds: 0.

## What shipped

A new daemon feature, `parked-questions`. A claim carries `questionsLater` only for a daemon that names it and `requests`. For a question on a plain machine run (no peer root, no parent, no subagent, no dry run, no guest or artifact scope) the open response carries `deferred: true`. The daemon then denies the `AskUserQuestion` call at once with a "the answer arrives later, end your turn" reason, and completes `done` with `awaitingAnswer: true`.

The server parks that run: status `waiting`, no lease, no `run.finished`. The reaper skips it (a null lease never expires), `markRunning` refuses it, and the machine claim predicate no longer counts it as holding the agent's lane or its session. When the last open question closes (web or Slack answer, expiry, a person withdrawing it), `settleParkedRun` ends the run with one conditional write, and one follow-up run starts in the same session with the answers as input. It takes the parked run's actor, depth and delegation (`continuationOf`), and its request id is `question-answer:<runId>`. The follow-up resumes the stored Claude session. An answer that lands before the turn ends is handled in either order. Approvals, peer runs, hand-off children and subagents keep the synchronous wait.

## Nits left

- `heartbeatRun` still accepts a parked run, so a late or retried heartbeat could give it a lease again. Refuse a `waiting` run with no lease.
- `parkIfAsking` does not repeat the `defersQuestion` eligibility checks, so a buggy daemon could park a subagent or hand-off run.
- If `startRun` throws after the parked run has ended (agent archived, D1 error), the answers are only logged and nothing retries.
- `continueParked` queries the asked questions before the `!session` return, and uses an `as Parameters<...>` assertion like the hand-off wake code.
- After the gate has parked, a model that asks again opens another deferred question. The gate could deny at once.
- The parked turn's own text is stored in `resultText` but not delivered as a reply to Slack or mail requesters.
- Missing tests: `defersQuestion` false cases, a withdrawn question, `awaitingAnswer` with no deferred question.
- The "local run with the fake runtime" check is covered by `requests-parked.test.ts` (ask, second task claimed while the first waits, answer, one follow-up that resumes the session). The fake runtime echoes and never asks, so no browser run was made.

## Ideas beyond scope

- Show a parked run as "waiting for an answer" on the Roster from its pending request.
- Retry a follow-up that failed to start, from the minute tick.

## Steps for Dom

- Deploy the Worker before the daemon. The strict `complete` schema of an older Worker rejects `awaitingAnswer`, but a new daemon never sends it to a Worker that does not send `questionsLater`.
- `apps/web` `guest-execution.test.ts` fails on main too (a workerd fetch failure in this environment), so it is not caused by this branch.
