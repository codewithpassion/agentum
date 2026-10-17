# C.9 review

Task: Pi durability suite. Branch task/C.9-pi-durability-suite.

## Verdicts

- Round 1 (ab26152): clean, 0 must-fix, 10 nits. No fix rounds.

The reviewer ran `bun test scripts/e2e` and `bun run check`, and they pass. It did not rerun the live script. After the review the dispatcher fixed two nits (the header wording about the `safe` case, and the sleep length now comes from one constant) and re-ran the checks.

## What changed

`bun run e2e:pi-durability` (root `package.json`, `scripts/e2e/pi-durability.ts`) runs against a real `vite dev` Worker with the scripted `faux` model, no API key:

1. The Pi packages (`agents`, `@earendil-works/pi-durable`, `pi-ai`, `chord`, `typebox`) are pinned exactly in `apps/web/package.json` and those versions are installed.
2. Unsafe tool: a library `bash` call sleeps 8 s. The script waits for the `tool.call` event with no `tool.result`, waits 2 s so Pi's execute checkpoint exists, and kills the dev server's process group with SIGKILL. After the restart the run ends `done`, there is one `tool.call` and one `tool.result`, the result is Pi's "interrupted and may have partially run" text, the tool's marker output (`ran-42`) is absent, and the model's answer carries the interrupted text.
3. Long outage: `runOutage` from C.4, unchanged. The server is down 120 s with the lease sweep running, and the run still ends `done`.

`cloud-outage.ts` gave up its setup code to an exported `withHarness` (server, migrations, agent, deps) and `parseHarnessArgs`, so both scripts share it. Its behaviour is the same. `waitForEnd` and `waitUntilRunning` are exported. `scripts/e2e/pi-durability.test.ts` covers `checkPins` and `runUnsafe` with fakes. The rule that every Pi bump runs the suite is in `docs/HANDOVER.md` under "Rules that are easy to break".

## Checks

- Live: `bun run e2e:pi-durability --port 3927` exited 0. All four unsafe assertions and all five outage assertions passed, about 5 minutes in all.
- The unsafe case discriminates: with the bridge's replay mapping in `pi-run-mcp.ts` forced to `"safe"` (reverted afterwards), the script fails with "Pi ran the tool again after the restart, its output was ran-42". That also shows a `safe` tool reruns on pi-durable 1.3.0.
- `bun run check`, `bun run test` and `bun run build` pass. The `drizzle` grep on `apps/web/dist/client` finds nothing.

## Not done: the `safe` case

The task asks for safe, unsafe and long-outage. The safe case is not built. The faux model only ever calls `harbourmaster_bash` (not read-only), and no platform tool is both read-only and slow. A connector stub is blocked by the SSRF guard unless a tunnel is used, and the faux model cannot call a connector tool anyway. The task limited the change to the script, its package.json entry and docs because C.5 and C.6 run in parallel. A safe case needs, in dev builds only: a faux prompt prefix that calls a named tool, and a read-only tool that sleeps (annotated `readOnlyHint`). The expected result is two executions of the tool and a normal result. The controller should add a follow-up task for it.

## Nits left

1. `pi-durability.ts`: `installed` reads only `apps/web/node_modules/<name>`. A future hoisted install would report "nothing is installed".
2. `waitUntilToolRuns` ignores the run status. A run that fails before its tool call waits 60 s and reports "never called its tool".
3. "Pi does not run the tool again" is judged from the tool result the model saw. A count of `library.command` rows for the run (expected 0) would prove it directly. Those rows probably have a null `seq`, so `seqEventsOf` cannot see them and it needs a direct query.
4. No unit test for the tool answering within `IN_FLIGHT_MS`, a wrong call or result count, output or `resultText` without the interrupted text, or `checkPins` with `installed` undefined.
5. The HANDOVER bullet is long next to its neighbours, and the coverage gap might sit better under "Things nobody has verified yet".
6. The outage session key is now `e2e-cloud-outage-faux-<ts>` and the "check passed" line prints after the server stops.

## Ideas beyond the scope

- The safe case above.
- Run the suite from a manual `workflow_dispatch` workflow once CI is allowed.

## Steps for Dom

None for accounts or dashboards. To run the suite: put `PUBLIC_BASE_URL=http://localhost:<port>` in `apps/web/.env.local` (the Worker reads it from that file only), then `bun run e2e:pi-durability --port <port>` from the repo root.
