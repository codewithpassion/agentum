# JB.1 review

## Verdict per round

Round 0, commit 1b9db46: clean. No must-fix findings.

`bun run check` and `bun run build` pass. `bun run test` is red in this environment for two causes that predate JB.1: the web test `guest-execution.test.ts` fails the same way on the `main` base, and the Rust test `desktop::apps::tests::the_session_bus_listens_where_the_environment_says` needs a working dbus-daemon. The services (4284) and web (4389) suites otherwise pass, with all five new tests.

## Nits left

- `JOB_SOURCES` in `packages/db/src/shared.ts` repeats `MAP_TRIGGER_KINDS` value for value. It could derive from `TRIGGER_KINDS` plus `slack`.
- `jobs.forAgent` and `jobs.list` skip `requireReader`, as the KY.1 stubs do, so a machine, trigger or Slack principal could read jobs once the real body lands. JB.2 should add it.
- The `"./jobs"` entry in `packages/services/package.json` sits among entries that were already out of alphabetical order.
- The setTimezone test covers admin success, member refusal and a bad zone in one test.

## Beyond the scope

- `draft` echoes the text as a `source: "app"` proposal. JB.3 replaces it with the model call.
- `runNow` always answers not found until JB.2 reads real job rows. Its result is `{ runId }`.
- `ProposedTrigger` carries `cron` and `timezone` for the routine case. JB.3 may want more fields for mail and Slack starts.

## Steps for Dom

None.
