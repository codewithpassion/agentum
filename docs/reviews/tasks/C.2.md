# C.2 review

Task: CloudRuntime adapter. Branch task/C.2-cloud-runtime.

## Verdict per round

Round 1, commit d3fb13b: clean, 0 must-fix, 12 nits. Checks run by the reviewer: `bun run check`, `bun run test`, `bun run build` and the `drizzle` bundle grep all pass. Each check in the task has a named test (dispatch, claim race, failed start releases the run, cancel).

No fix rounds. After the review, the dispatcher fixed nit 3 (the form text) in the merge commit.

## What changed

`cloud` joins `AGENT_RUNTIMES` (no SQL migration, the column is plain text). `claimRun` refuses a run when its agent has a running run or an older run of its session is waiting. `releaseRun` puts a claimed run back to `offered`. `createCloudRuntime` claims, signs the run token, builds the MCP servers and calls `CloudRunnerPort.start`. A start that throws releases the run and the minute sweep offers it again. The app registers the adapter only when `Infra.cloudRunner`, `RUN_TOKEN_KEY` and `PUBLIC_BASE_URL` are set, and nothing supplies a runner until C.3.

## Nits left

1. `releaseRun` writes no event, so a retry logs `run.started` twice.
2. The cloud option shows in production before C.3 supplies a runner. A first message to a cloud agent fails with "No runtime is registered for cloud agents".
3. Fixed: the form said cloud agents can use skills, which waits for C.7.
4. The connector-assignment query in `cloud/runtime.ts` copies `managed/service.ts`.
5. The agent-busy and older-run conditions now exist in `runs.ts`, `runs/machine-claim.ts` and `managed/service.ts`.
6. The busy check is per agent, so one cloud agent works one session at a time across the workspace. Managed blocks per session. This follows the task text.
7. `cloud/runtime.ts` imports the run token key a second time instead of taking a `signToken` dependency.
8. `cancelRun` calls the adapter for queued runs the runner never saw. The runner must tolerate an unknown run id (C.3).
9. The fake runtime does not catch the new claim `conflict`. Dev only.
10. Nothing offers the next waiting run when a cloud run finishes, so it waits for the sweep (60 s plus the minute tick).
11. If `runner.start` throws after the Durable Object accepted the run (an RPC timeout), the run returns to `offered` while the object keeps working. Its run token is invalid until the sweep claims the run again. C.3 and C.4 must handle this.
12. The "two simultaneous claims" test runs on synchronous `bun:sqlite`, so it proves the conditional write and not true concurrency.

## Ideas beyond scope

- One shared claim helper for machine, managed and cloud (nit 5), with the connector query (nit 4).
- An `offerNext` after a cloud run completes, like managed has (nit 10).
- Decide in C.3 whether the busy rule should be per session for cloud, as for managed (nit 6).

## Steps for Dom

None for C.2. Cloud agents cannot run until C.3 supplies the runner (`Infra.cloudRunner`), so no deploy or dashboard step belongs to this task.
