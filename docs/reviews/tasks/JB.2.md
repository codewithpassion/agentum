# JB.2 review

## Verdict per round

Round 0, commit 329786f: must-fix. `lastRunOk` read a queued or running run as failed. `forAgent`, `list` and `runNow` let a run principal read or start another agent's jobs.

Round 1, commit 0fc8a98: clean. `lastRunOk` is null while the last run is live. A run sees only its own agent's jobs and can start only its own agent's routines.

## Nits left

- `cronToWords`: `*/N` where N does not divide 60 reads "Every N minutes" but fires at :00 and :N, and `0-6` for weekdays lists seven names instead of "Every day". A zone label compares zone strings, so `Etc/UTC` against a `UTC` workspace gets a "(UTC time)" label.
- A routine with a null or empty cron reads `when: ""`.
- `nextRunFor` calls `nextFireTime` without a guard, so a bad cron on an enabled routine with a null `next_run_at` would make the whole list throw. Create and resume always set `next_run_at`.
- A routine's `does` has no length cap, while the job line is capped at 140 characters.
- One runs query per trigger (N+1), cheap through `runs_actor_idx`.
- The `trigger.fired` payload of `runNow` holds the full request id, while the cron path holds the slot time.
- `cancelled` and `interrupted` runs read as `lastRunOk: false`.
- `draft` has no `requireOwnAgent`. It echoes text today, so JB.3 should add it.
- `runNow` answers not found before it checks the agent, as `routines.ts` and `triggers.ts` do.

## Beyond the scope

- A double click on Run now starts two runs, since each press has its own request id. The Jobs tab (JB.4) could disable the button while a call is open.
- `settleRuns` counts runs started by `runNow` toward the five-error limit, so five failed manual runs switch a routine off.
- `apps/web/src/components/routines/describe-cron.ts` is an older web-side copy of the cron-to-words idea. JB.4 could drop it for the service's words.
- Slack sentences have no run history (`lastRunAt` and `lastRunOk` are null): Slack runs are attributed to the linked user, not the app.

## Steps for Dom

None. `bun run test` shows one failing web test, `live-artifacts/guest-execution.test.ts` (ECONNRESET), which also fails alone and on `main`. The Rust test `desktop::apps::tests::the_session_bus_listens_where_the_environment_says` fails when the worktree path is long.
