# AA.13 review record

Gate 1: peer questions expire in an hour, answers count against the limit, unsupported media refused. Findings N1, N5 and N13 of `docs/reviews/AA-1.md`. Spec: `docs/v3/agent-connections.md`.

## Rounds

- Round 1, at 845cba14: one must-fix as the reviewer marked it, which the dispatcher ruled out of scope (see below), and nits. The nits that were cheap are fixed in b212a8b9: an empty `mediaType` counts as plain text, and a run that will not cancel after its question expired is logged instead of stopping the expiry loop. No second reviewer ran, because no must-fix was applied.

The reviewer's must-fix: `request_human_takeover` skips the tool gate and lasts 24 hours (`TAKEOVER_TTL_MS`), so a peer-rooted run can still hold an agent for a day per message through a takeover. The task scope names questions only, so the takeover was left alone. It is the first item under ideas.

## What changed

- A question opened in a run with a peer anywhere in its chain (`peerRootOf`: a run the peer started, a hand-off, a wake) lasts `PEER_QUESTION_TTL_MS`, 1 hour. Other runs keep `QUESTION_TTL_MS`, 24 hours. `requests.open` decides it in `ttlOf`, so every caller gets it.
- `expireDue` announces `request.expired` with `kind`, then cancels the run for a peer-rooted question instead of waking it. The a2a `onEvent` ends the task `TASK_STATE_FAILED` with `STATUS_TEXT.unanswered` on that event, before the run's own cancelled event, so the task is not left CANCELED. An approval that expires still resumes the run.
- `hourlyCountSql` and `hourlyUse` count `a2a_answer_markers` too. `claimAnswer` writes its marker with an insert-select guarded by the hourly count, so two answers at once cannot both take the last place. A refused answer writes no marker, leaves the question open, records `a2a.rate_limited` and throws `A2aRateLimitError`, which both bindings answer as 429 with `Retry-After`. A retried message id returns the task before any limit check.
- `textOfParts` refuses a text or data part whose `mediaType` is not a `text/*` or JSON type (`application/json`, `+json`), parameters and case ignored. `text/plain` from Hermes passes.
- Spec: the part types row, the `INPUT_REQUIRED` row, the `hourly_limit` row and "Not in this build" (the cap bullet became the one-run-at-a-time line, since the cap now exists for peers). `packages/services/src/a2a/README.md` says answers count.
- Tests: media types (`tasks.test.ts`), the 1 hour and 24 hour lifetimes, failing and cancelling at expiry with the agent freed, a member run resuming at expiry (`tasks.test.ts`), the answer limit, retry, an hour later and two at once (`tasks-races.test.ts`), 429 with `Retry-After` on both bindings (`a2a-card-auth.test.ts`).

## Checks

`bun run check`, `bun run test` and `bun run build` pass, and the build has no `drizzle` in `apps/web/dist/client`. `bun scripts/e2e/a2a-hermes.ts` against Hermes v0.22.5 passed 8 of 8 and exited 0. It needed uv 0.13, which this machine lacked (it has 0.8.15), so it ran with a uv 0.13.6 installed in a scratch venv under `tmp/AA.13/uvenv`, passed as `--uv`.

## Nits left

- A non-conflict error from `cancelRun` at expiry is only logged, so the task is FAILED and the run may stay alive until the sweep finds it.
- If the `request.expired` listener fails, the sweep later ends the task CANCELED, not FAILED with the "nobody answered" text.
- An answer that loses the race to a closed question keeps its marker and so uses a place in the hour.
- `a2a_answer_markers.created_at` has no index and markers are never pruned, so each limit check reads the connection's marker history. `a2a_tasks` has the same gap.
- At `hourly_limit = 1` the task takes the only place, so an answer can land only after the task's hour is up.
- Peer-rooted means hand-offs and wakes too. A question in a wake on a member's own outbound conversation also lasts 1 hour and then cancels its run, with no task to say why. The spec's "a run a peer started" and "a member's run keeps 24 hours" are looser than that.
- The spec's FAILED and CANCELED row still reads a cancelled run as CANCELED only, and "both directions" on `hourly_limit` reads as if outbound answers count (only inbound answers have markers).
- `apps/web/src/components/connections/policies-panel.tsx` still says "Tasks per hour".
- Not tested: an approval expiring on a peer run, two questions expiring together, the 1 hour limit on a hand-off or wake run, and the retry branch inside `claimAnswer`.

## Ideas beyond the scope

- Give `request_human_takeover` the 1 hour lifetime and the cancel on expiry for a peer-rooted run, or refuse it there. It is the one way left to hold an agent for a day.
- Index `(connection_id, created_at)` on `a2a_answer_markers`.
- Say in the connection's UI that answers count against the limit.

## Steps for Dom

None that need an account or a dashboard.
