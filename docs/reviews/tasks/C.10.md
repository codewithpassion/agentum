# C.10 review

Task: Safe-tool case for the Pi durability suite. Branch task/C.10-safe-tool-durability.

## Verdicts

- Round 1 (61d3ccf): clean, 0 must-fix, 4 nits. No fix rounds.

The reviewer ran `bun run check`, `bun run test` and `bun run build`, and they pass. It also built with `NODE_ENV=development` and showed the guard fails on that output. It did not rerun the live script.

## What changed

Dev builds register a read-only tool, `dev_slow_read` (`apps/web/src/server/pi-run-dev-tools.ts`, `replay: "safe"`). It counts its starts in the object's storage, sleeps 8 s and answers `slow read done, started <n> times`. `PiRun` loads it inside the existing `import.meta.env.DEV` branch, next to the faux model, so a production build drops the module. The faux `call <tool> <json>` prompt already existed from C.5 and is unchanged.

`bun run e2e:pi-durability` now has a safe case between the unsafe and long-outage cases. It kills the dev server during the call. After the restart the run ends `done`, there is one `tool.result` that says `started 2 times` and not the interrupted text, and the model's answer carries the rerun text.

`apps/web/scripts/check-dev-only.ts` runs after `vite build` in `build` and `staging:build`. It fails the build if `dist/server` holds the tool name or its storage key. I saw it fail on a first draft where the import sat in a method outside the DEV branch, then pass after the import moved into the branch.

## Checks

- Live: `bun run e2e:pi-durability --port 3931` exited 0. The unsafe, safe and outage cases all passed.
- `bun run check && bun run test && bun run build` pass, and the guard prints `ok, 100 server files checked`.

## Nits left

1. `scripts/e2e/pi-durability.ts:229`: the error text says "at least one tool.call and one tool.result", the condition wants exactly one result.
2. `scripts/e2e/pi-durability.ts:156`: the shared pre-kill message names `TOOL_SLEEP_MS`, the bash script's sleep. The safe tool's is `SLOW_READ_MS`. Both are 8000.
3. `scripts/e2e/pi-durability.ts:52`: `INTERRUPTED`, `SAFE_PROMPT` and `SAFE_RERUN_TEXT` are exported but nothing imports them.
4. `pi-run.ts:87`: in dev builds the tool is installed for every session, so a real model in local dev also sees `dev_slow_read`.

## Ideas beyond the scope

- Count `library.command` rows for the unsafe run (expected 0) to prove directly that Pi did not rerun it (C.9 nit 3).

## Steps for Dom

None. To run the suite: put `PUBLIC_BASE_URL=http://localhost:<port>` in `apps/web/.env.local`, then `bun run e2e:pi-durability --port <port>` from the repo root.
