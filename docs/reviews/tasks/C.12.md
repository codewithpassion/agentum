# C.12 review notes

Skill scripts for cloud agents. Branch task/C.12-cloud-skill-scripts.

## Decision: a Dynamic Worker, called directly

Cloud agents run Pi in the `PiRun` Durable Object. The skill files live in the workspace library (D1 and R2 through the services), and a script must run in something that starts clean for each call, holds only that skill's files, and has network but none of our secrets. Dom changed the network rule on 17 Oct 2026: scripts need outbound access. The comparison below uses that rule.

| | `@cloudflare/computer` | Sandbox SDK (container) | Dynamic Worker (Worker Loader) |
|---|---|---|---|
| Runs a `.ts` file with relative imports | No. Its stable JavaScript backend runs ES modules only, and its shell backend is experimental (just-bash, JS off in the browser build). We would still strip types ourselves. | Yes. Bun or Node in the image runs `.ts` directly. | Not directly. Types are stripped first (sucrase and acorn together, 330 KB minified, 83 KB gzipped), and each skill file becomes a module. |
| Where the files live | Its own SQLite filesystem in a Durable Object (`withWorkspace` mixin, needs `ai`, `zod` 4, `vite` and `@platformatic/vfs` as peers). Skill files would be copied in on each run, and the mixin lands on `PiRun`, which C.13 is changing. | Written into the container per run. | Passed as the module map of the call. Nothing is stored. |
| Start-up | Isolate speed for the Worker backends. The container backend is experimental and cold-starts slowly. | Container cold start, 1 to 3 s by Cloudflare's FAQ, more with a big image. | About 10 ms measured locally for a TypeScript script with an import. |
| Cost | Isolate backends bill as Dynamic Workers. | vCPU-seconds, GiB-seconds and disk while awake, plus the Durable Object for each sandbox, and egress. Needs the Containers feature on the account. | Workers Paid. 1,000 unique Workers a month included, then $0.002 for each per day. Requests and CPU time bill as Workers. No idle cost. |
| Limits | 3 minute default run cap, about 5 minutes of CPU, 10 Dynamic Workers in flight per Durable Object. | Instance size limits, thousands of concurrent containers. | `cpuMs` and `subRequests` per load, 4 in flight per request and 10 per Durable Object. Only a script's own imports work: no npm install. |
| Network | `globalOutbound` choice per backend. | On by default. Egress can be controlled through outbound Workers. | On when `globalOutbound` is left out. A call with no `env` holds none of our bindings, so no secret reaches it. |
| Local dev | Needs a Worker Loader binding. | Needs Docker to build and run the image under `vite dev`. | Works in `wrangler dev` and `vite dev` with a `worker_loaders` binding. `cpuMs` is not enforced locally. |
| Bundle and `wrangler.jsonc` | A new dependency tree, plus the binding and the mixin. | `@cloudflare/sandbox`, a Dockerfile, a `containers` block, a new Durable Object class and a `v4` migration, in three places. | `acorn` and `sucrase` (about 330 KB minified), and `worker_loaders` in three places. No migration. |

The Sandbox SDK is the only one that gives a real Linux shell and arbitrary npm packages, and it costs a container image, a migration, Docker in dev and the Containers feature on the account. The task needs a `.ts` file that imports its own skill files and standard APIs, which a Dynamic Worker covers. `@cloudflare/computer` adds a filesystem we do not need, and its stable backend would not run `.ts` either. So the call goes to the Dynamic Worker, behind a port (`SkillScriptSandbox`), so a container backend can replace it if scripts later need npm packages or binaries.

One sandbox is made for each call and is garbage after it returns (`LOADER.load`, no caching). A Dynamic Worker has no sleep state, so there is nothing to destroy. The wall-time stop gives up on the call and reports 124, and the CPU limit (`cpuMs`) ends a runaway script on Cloudflare.

### What the sandbox gives a script

- `process.argv` is `["bun", "/<path>", ...args]`, `process.env` is empty, `process.exit(n)` ends the run with that code (a script's own `try/catch` can swallow it, and `process.exitCode` is ignored), and `console` and `process.stdout` write to the captured streams.
- A script imports its own skill files with the extension, as in `./lib.ts`. JSON files import as JSON. Other files are data modules. Extensionless imports and npm packages do not resolve.
- The entry script is wrapped in an async function, because a Worker may not do I/O while a module loads, and `await fetch(...)` at the top level is I/O. A top-level call statement such as `main();` or `main().catch(...)` is awaited, since Bun waits for that work and the wrapper would not. Other detached work (a `setTimeout` callback, an un-awaited `.then` chain inside a function) is dropped when the entry function returns. An `export default` or an export list in the entry is refused with a message. A named `export const` is turned into a plain `const`. `import.meta.main` is undefined, and only the entry is wrapped, so another module that does top-level I/O fails.
- No `env` is passed and nothing else of ours is in the isolate. The check script printed an empty `process.env` and no global named like a binding.
- Network is on (`globalOutbound` left out). Outbound requests are capped at 50 for each run. The isolate has no route to anything of ours except the public origin.
- `Bun` and `Deno` globals do not exist.

## What was built

`apps/web/src/server/skill-scripts/`: `sandbox-port.ts` (the port), `run-skill-script.ts` (the Pi extension with the `run_skill_script` tool, a 30 s time cap with a 2 s safety net, a 64 KB cap for each of stdout and stderr, exit code 124 on a timeout), `script-bundle.ts` (types stripped, entry wrapped, modules keyed by skill-relative path), and `dynamic-worker-sandbox.ts` (the Worker Loader backend and its harness). `PiRun.#applySkills` installs the extension next to the skills extension. `activate_skill` and `read_skill_resource` now point at `run_skill_script`. `LOADER` is in `wrangler.jsonc` at the top level, in `env.staging` and in `env.staging.previews`. There is no migration. The agent form note no longer says scripts do not run.

Checks: unit tests for the tool with a fake sandbox (file placement, time cap, output cap, non-zero exit, bad paths, a rejecting sandbox) and for the bundler. Live on a local dev server with the workspace key stored through Settings: a cloud agent (Haiku) with the skill `ts-hello` (`SKILL.md`, `scripts/hello.ts`, `scripts/lib.ts`) replied `codeword: RUOBRAH-5285` for `harbour`, which is the reverse upper-cased word and the sum of its character codes times 7. A second script that calls `fetch("https://example.com")` returned `status: 200`. A harness in plain workerd also showed a non-zero `process.exit`, a thrown error with a stack, a syntax error that names the file, 1 MiB stream capping and a 3 s wall-time stop. `bun run check`, `bun run test` and `bun run build` pass, and the bundle grep for `drizzle` finds nothing.

## Verdicts

Round 1 at b624a7c: must-fix. One item. A script that starts its work with `main();` and no `await` returned exit 0 and empty output, because the harness returned when the wrapped entry function resolved. Bun waits for that work, so skill authors will write it.

Fix at 61cea41. A top-level call statement in the entry is awaited. The fix commit also dropped `.tsx` (sucrase ran no JSX transform), moved `TIMEOUT_EXIT_CODE` into the port, made `process.exit` ignore a non-integer code, and wrote the remaining limits into this file.

Round 2 at 61cea41: clean.

## Nits left

- A wall-time timeout reports 124 but does not abort the Dynamic Worker. A script waiting on the network can keep making requests (up to 50) after the model has its answer. Whether a hung run counts against the in-flight cap (4 for each request, 10 for each Durable Object) is not checked. Cloudflare's `cpuMs` ends a runaway script.
- `process.exit` edges: a script's own `try/catch` can swallow it, `process.exitCode` is ignored, and `true`, `null`, `1.5`, `256` and `-1` differ from Node.
- Top-level calls run one after another, so `a(); b();` is sequential where Bun runs both at once, and output order can change. A call that returns a promise that never settles hangs until 124. `void main();`, `a(), b();` and `main?.()` in plain `.js` are not awaited.
- The harness cuts a stream by UTF-16 units against a byte budget, so the 1 MiB cap can overshoot on multi-byte text. After that cut the truncation note shows the capped size, not the real total.
- Only `console.log`, `info`, `debug`, `warn` and `error` are captured. `console.table`, `dir`, `trace` and `group` go to the Durable Object logs. `process.stdout.write` of a `Uint8Array` prints "1,2,3".
- Imports move to the top of the entry and a wrapper line is added, so line numbers in entry-script stack traces differ from the source.
- `import.meta.main` is undefined in workerd, so Bun's `if (import.meta.main) main()` does nothing. A non-entry module that does top-level I/O fails, since only the entry is wrapped.
- Every skill file, SKILL.md and binary assets included, is read and loaded as a module on each run, with no cap on total bytes.
- The compatibility date in `dynamic-worker-sandbox.ts` is hard-coded apart from `wrangler.jsonc`. The harness needs it to be 2026-08-04 or later.
- Nothing runs a script through the real harness in a test. The harness only runs in workerd, so it was checked by hand against a dev server and a plain wrangler spike.

## Ideas beyond the scope

- Cache the Worker with `LOADER.get(hash of the modules)` so repeated runs of the same skill version count as one billable Dynamic Worker. Each `load()` with no id counts as one, and every one past 1,000 a month costs $0.002.
- A Sandbox SDK backend behind `SkillScriptSandbox` for skills that need npm packages or binaries. The port is already the seam.
- A test that runs the harness in workerd (for example through `@cloudflare/vitest-pool-workers`), so the harness has coverage beyond the live check.
- Give a skill an explicit secret on request, through a per-skill env passed to the load. The task allows it, and nothing builds it yet.

## Steps for Dom

- Dynamic Workers needs the Workers Paid plan on the account the Worker deploys to. Nothing else changes for deploy: no migration, no container, no secret.
- Staging check after deploy: make a cloud agent with a skill that holds a script (the live check used `ts-hello` with `scripts/hello.ts`, `scripts/lib.ts` and `scripts/probe.ts`, written under `skills/<agentId>/ts-hello/` in the library), ask it for the codeword, and ask it to run the script that calls `fetch("https://example.com")`.
