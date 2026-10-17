# C.3 review

Task: PiRun Durable Object. Branch task/C.3-pirun-do.

## Verdicts

- Round 1 (c0ee4e2): not clean, 3 must-fix, 12 nits.
- Fix round 1 (cc79b52), reviewed: not clean, 1 must-fix, 6 nits.
- Fix round 2 (c0b44e6), reviewed: clean, 0 must-fix, 5 nits.

Round 1 must-fix items, all fixed in cc79b52. One failed status read inside the flush `catch` stopped every later flush, so the run never completed. A conflict counted as "run is over" unless the status was queued or offered, so a run claimed again in between was aborted. `session.messages()` is the model's context, and compaction cuts it, so a long run lost its slice. Fix round 1 found one more, fixed in c0b44e6: a run could complete from an older slice after its last flush failed.

## What changed

`PiRun` is named by the session id. Each run is one Pi submission whose operation id is the run id, so a repeat dispatch submits nothing. The logic is in `pi-run-core.ts`, which bun tests with a fake Pi. `pi-run.ts` is the Durable Object, `pi-run-port.ts` is the `CloudRunnerPort` that `compose` now supplies, `pi-run-events.ts` translates a slice of the transcript into run events, usage and failure text, `pi-run-mcp.ts` turns MCP tools into Pi tools, and `pi-run-faux.ts` is a scripted model that dev builds load behind `import.meta.env.DEV` (it is not in the production bundle).

Runs in a session are told apart by the user entry Pi placed for each submission. A run reports the entries from its own user entry up to the next run's user entry, and its seq is the position inside that slice, so a replay after a wake is a no-op. Flushes for a run go one at a time. A run completes with the final assistant text and a usage sum, or fails with the `errorMessage` of the model's last error message, falling back to Pi's reason. Cancel aborts the submission and ignores a run the object never saw (C.2 nit 8). A run that arrives while the session is busy is submitted with `whenBusy: "steer"`.

A conflict from the platform ends the run's work only when the run has a terminal status. A run that is queued or offered again (`releaseRun` after a start that looked failed, C.2 nit 11) keeps working, and the second start finds it in the object and reports it. A run counts as complete only after its last report landed.

Other changes: `cloudRunner` is supplied in `compose`, `@earendil-works/chord` moved from devDependencies to dependencies (the object imports `BACKGROUND_CONTEXT`), three dev routes under `/api/dev/cloud/:action` (`offer`, `redispatch`, `cancel`), and `scripts/e2e/cloud.ts`.

## Checks

- `bun run check`, `bun run test` and `bun run build` pass at c0b44e6. The `drizzle` grep on `apps/web/dist/client` finds nothing. The faux module is not in `dist/server`.
- `scripts/e2e/cloud.ts` ran four times against `vite dev` and passed all eight scenarios each time: a run through the normal lifecycle, two runs in one session with their own events, the same run dispatched twice while it works, cancel, a new run after the abort, a model failure that ends with the model's text, a tool call through the platform's `/mcp`, and no duplicate `(run_id, seq)` rows. It ran under `vite dev` and not `wrangler dev`, because the faux model loads in dev builds only. How to run it is in the header of the script.
- Pi's retry is off for the faux model (the scripted failure would only slow the check down) and on for Anthropic (3 tries, 1 s base).

## Nits left

1. `flush` reads the whole transcript from the run's entry on and calls `entryOf` for every run of the session on each commit. The cost grows with the session.
2. A run whose completion or last report keeps failing stays `active` in the object with its run token, and nothing wakes the object once Pi is idle. The reaper ends the run `interrupted`. C.4 owns the wake.
3. `harness.storage()` is marked internal in `agents`. PiHarness itself uses it for `submissionByRequest`. An `agents` or pi-durable bump can break `entryOf`. The shape test and the e2e script are the guard.
4. `compose` always supplies `cloudRunner`, so a cloud agent now claims its run and fails at the provider ("no credentials") until C.6 wires the workspace key. The form already shows the option.
5. Scenario 3 of the e2e script (same run dispatched twice) only proves that nothing duplicates by the final seq check. It does not test the path where the first work finishes while the run is `offered`. The core tests cover that.
6. `resume` and the busy path of `start` set the model only for the first idle submit.
7. Heartbeat is an in-process 20 s interval, a stopgap that dies with the object. C.4 replaces it.
8. No bun test covers the `again` re-run (a start that lands as the work ends) or the tool uninstall in the Durable Object class.
9. A tool name that collides after the 64 character cut gets `_2`, `_3` in the order `tools/list` returns the tools. A server that reorders its list between runs swaps the names.
10. `listMcpTools` is strict: one unreachable connector fails the whole start, the run is released, and the sweep offers it again each minute until it expires. C.5 can decide whether a down connector should only drop its own tools.
11. The two new final-flush tests do not count attempts, and no test covers an offered run whose final report is refused.
12. The e2e script on local D1 meets `SQLITE_BUSY` now and then, because the script and the dev server share the SQLite file (M1.7). The runner survives it and logs the failed read.

## Ideas beyond the scope

- Steer is dormant through the normal flow. `claimRun` allows one running run per agent, so a second message in a session stays queued until the first run ends. It only meets a busy session while an abort winds down. If Dom wants real steering, the cloud busy rule has to become per session (as managed has it), which is a change in `claimRun` and C.2's decision. C.2 nit 6 handed this to C.3, and C.3 kept the per-agent rule.
- One shared claim helper for machine, managed and cloud, as C.2 suggested.
- A `bun test` that loads `PiRun` under the `cloudflare:workers` shim, to catch import breakage before a deploy.

## Steps for Dom

None for accounts or dashboards in this task, since cloud agents cannot call a real model until C.6. For the controller's staging deploy, the spike's open check still applies: confirm that a `PiRun` on the deployed Worker can fetch the Worker's own `/mcp` at `PUBLIC_BASE_URL` (or needs a self service binding, C.5), and read the Worker startup time and the CPU time of one turn from the deploy output and `wrangler tail`.
