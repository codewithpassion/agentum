# C.17 review notes

run_script for isolate agents. Branch task/C.17-isolate-run-script.

## What was built

`run_script` runs a `.ts`, `.js` or `.mjs` library file, or inline code, in a Dynamic Worker, through the same bundler, harness, limits and output cap as skill scripts. Relative imports are collected from the library (up to 100 files). The sandbox gets a `HOST` RPC binding (`ScriptHost`, props: run ids, home folder, network flag) and `globalOutbound: null`. The harness turns it into a `library` global (`read`, `write`, `list`), a `stdin` global and a `fetch` that goes through `ScriptHostApi.send`. `send` uses `runWebFetcher` with `via: "run_script"`, so the C.15 setting, address blocking, C.16 placeholders and `network.request` entries apply. With network off, `fetch` rejects with "Network access is off for this agent." Each run writes a `script.run` event (path or "inline", exit code, duration, output sizes). The isolate prompt gets the paragraph through `workspaceInstructions({ runScript: true })`; the VM and the daemon don't. The library `bash` description points to `run_script`.

## Deviations from the task text

- The task says skill scripts already have a small library file API. They don't: the C.12 sandbox only gets a module map. The `library` API is new, built as an RPC binding.
- No `https://` imports. The Worker Loader doesn't fetch module URLs and the skill path never allowed them, so the tool description says npm packages and https imports aren't available.
- `run-skill-script.ts` changed only by four added `export` keywords (plus the line wrap that causes), because R.3 edits that file.
- `describeRun` in `run-script.ts` repeats `describeResult` with an added duration line. Merging them touches the R.3 file, so it is left for later.
- No migration. `events.type` is a plain text column. `bun run generate` after merging main emitted nothing new.

## Verdicts

Round 1 at 073b667: must-fix. One item: `HOST.write` accepted a non-`Uint8Array` from a script that holds the stub, which skipped the size checks in the library service and could overwrite a blob without updating its row. Fix at 910260b: `list`, `read` and `write` check their argument types, and `host()` in `ScriptHost` became `#host()`.

Round 2 at 910260b: clean.

## Nits left

- `script-host-core.ts` `send` doesn't check the types of `url`, `method` and `headers`, and `send(null)` throws instead of returning `ok: false`. The comment on the type checks says "every argument".
- No test for the `send` body type check.
- `ScriptHost` builds the services (`compose`) on each RPC call.
- Redirects the fetcher follows inside `ScriptHost` don't count toward the 50-subrequest limit, and nobody has checked on a real Worker that `HOST` calls count at all. The tool description promises "at most 50 library and network calls".
- The harness `fetch` ignores `init.signal` and `redirect`.
- `process.argv[1]` is `/agents/x/foo.ts`, not `/library/agents/x/foo.ts`.
- A rejecting sandbox writes no `script.run` event.
- Import collection has a file cap (100) but no total byte cap; it reads into the Durable Object's memory.
- With `nodejs_compat` on, workerd may provide some `node:` modules (such as `node:fs`), so "Node built-ins aren't available" is a statement of policy more than a guarantee.
- `libraryToolsExtension` hard-codes `runScript: true` while `installEnvironmentTools` installs the tool only when `scripts` is passed. PiRun always passes it.
- A fetched body that echoes a filled secret reaches the script output unscrubbed, like `web_fetch` and `curl` today. Headers and status text are scrubbed. The test pins the header case.
- A script cannot be stopped by a CPU loop locally: `cpuMs` only applies on Cloudflare, and the bun stand-in (`local-worker-loader.ts`) only tests the wall-time stop with a script that never settles.

## Ideas beyond the scope

- Scrub filled secret values out of fetched bodies for `web_fetch`, `curl` and `run_script` together.
- Give `run_script` a `cwd`-style argument, or run a script with the home folder as `process.cwd()`.
- `process.stdin` as a stream for scripts written for Bun and Node.
- A shared `describeResult` for both script tools after R.3 merges.

## Steps for Dom

Live check on staging (the controller's step in the task): an isolate agent writes a small TS file to its home, runs it with `run_script`, and fetches a public URL from a script. While there, confirm that library calls from a script work through the `HOST` binding on real workerd (Uint8Array over RPC, errors with their messages), and what happens at the 50th combined call. No new binding or secret is needed; `ScriptHost` is exported from the Worker entry like `SecretsOutbound`.
