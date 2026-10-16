# Spike: Pi Durable agents on Cloudflare

17 October 2026. Task C.0. Nothing here is merged into the app. The prototype lives in `/home/roboto/devel/harbourmaster-wt/tmp/spike-pi-durable/` and the draft tasks are for Dom to accept, change or drop.

## Short answer

Go, as an opt-in runtime with exact version pins.

`PiHarness` runs inside the real Harbourmaster Worker. I ran a Pi agent in a Durable Object under `vite dev`, started from a real Harbourmaster run, and the run finished through the normal lifecycle (`run.started`, `tool.call`, `tool.result`, `message.assistant`, `run.finished`). The agent called the real `/mcp` library `bash` and a connector through `/api/proxy` with a run token. It read an S.1 skill. I killed the dev server (`kill -9`) mid-tool, restarted it, and the run resumed by itself and finished.

Four things make this a conditional go:

1. Pi Durable is experimental and already broke between minor versions. Tool results were renamed from `content` to `output` between 1.1.0 and 1.2.0. With pi-durable 1.3.0, the skills tools in `agents@0.28.1` return `content` and the model silently gets empty text. Pin exact versions and run the durability test on every bump.
2. There is no shell and no file system in a Durable Object. Pi's own `read`, `write`, `edit` and `bash` tools fail with "No execution environment is configured". The cloud runtime works today for agents that need library `bash`, connectors and skills. Agents that need a real shell need Sandbox or Containers.
3. The run lease (90 seconds, heartbeat every 20) and the lease reaper do not fit a Durable Object that can be evicted. A cloud run needs its own heartbeat, and an outage over 90 seconds still interrupts it. Details in question 4.
4. `authorizeRunWrite` only lets the `system` principal or the claiming machine write run events. The Durable Object lives in the same Worker, so it uses `SYSTEM_PRINCIPAL` in process, the way the fake runtime does. This works, but it is a decision to record.

Live Anthropic calls were not run. `apps/web/.env.local` has no `ANTHROPIC_API_KEY`. The real `@anthropic-ai/sdk` path ran against a local fake Messages API instead (question 5).

## What was built and where

All paths are under `/home/roboto/devel/harbourmaster-wt/tmp/spike-pi-durable/`.

- **Standalone Worker.** `src/server.ts` has a `PiRun` Durable Object, `src/platform.ts` a stand-in for Harbourmaster (MCP endpoint plus events and complete routes), and `src/mcp.ts` a small MCP client that turns each MCP tool into a Pi tool. `mock-anthropic.ts` fakes the Anthropic Messages API. `durability.sh` kills and restarts `wrangler dev`.
- **Real Worker experiment.** `worktree-experiment/real-worker.patch` and `worktree-experiment/pi/` hold the code I added to the C.0 worktree and then reverted: `agents` 0.24.0 to 0.28.1, three new dependencies, a `PiRun` class, a `v2` migration, and a dev-only start route. `real-run.ts` creates a real agent and run in the local D1 database and dispatches it through a prototype cloud adapter into the Durable Object. `real-durability.sh`, `real-lease.sh` and `reap.ts` run the kill tests.
- **Evidence.** `evidence/` holds the logs quoted below. Some figures come from console output I did not save: the dry-run bundle totals (the bundles themselves are in `/home/roboto/devel/harbourmaster-wt/tmp/C.0/base-dist` and `pi-dist`), the timings of single `real-run.ts` runs, the `connector.call` outcomes for `tools/call` and for the blocked `localhost` target, and the fake Anthropic server's request records. They are marked "observed" where they appear.
- **Where the adapter ran.** The prototype adapter ran inside the Bun script `real-run.ts` against the local D1 file, not inside the Worker. Only `PiRun` and its in-process calls into the services ran in the Worker. The Worker-side path from `startRun` through a registered adapter is untested.

Versions used: `agents` 0.28.1, `@earendil-works/pi-durable` 1.3.0, `@earendil-works/pi-ai` 1.3.0, `typebox` 1.3.27, wrangler 4.147+. The task file says Agents SDK 0.26.0. The example in `cloudflare/agents` is at 0.28.1, which is why I used it.

## 1. Does PiHarness run in our Worker?

Yes, in the same Worker. No service-bound second Worker is needed.

Evidence in the real Worker (`apps/web`, branch worktree C.0):

- **Dependency bump.** `agents` `^0.24.0` to `0.28.1`, plus `@earendil-works/pi-durable`, `@earendil-works/pi-ai` and `typebox`. After the bump alone, `bun run typecheck` passes, `bun run build` passes, `bun test` in `apps/web` passes (521 tests, 0 fail), and the 78 MCP tests still pass. `createMcpHandler` from `agents/mcp/server` still exists, so `/mcp` is unaffected.
- **Build.** No change to `vite.config.ts` was needed. The example's `resolve.dedupe` list was not required. `grep -rl drizzle apps/web/dist/client` finds nothing.
- **Config.** The Durable Object needs `nodejs_compat`, which the Worker already has. I added a `PI_RUN` binding and a `v2` migration with `new_sqlite_classes: ["PiRun"]`. No other compatibility flag was needed.
- **Runtime.** `vite dev` served the Worker and `PiRun` ran turns inside it. The `AI` binding and `worker_loaders` from the Cloudflare example are only needed for Workers AI and the JavaScript exec backend, which I did not use.

Bundle size from `wrangler deploy --dry-run --config dist/server/wrangler.json`:

| | Total upload | gzip |
|---|---|---|
| Before (main) | 6907.93 KiB | 1549.74 KiB |
| With `PiRun` and Anthropic provider | 8614.66 KiB | 1915.20 KiB |
| Added | 1706.73 KiB (+25%) | 365.46 KiB (+24%) |

The standalone spike Worker, with the same Pi code and no Harbourmaster, is 1851 KiB / 342 KiB gzip. Cloudflare removed the compressed size limit on 4 September 2026 and now checks 64 MiB uncompressed, so size is not a blocker. The Worker startup limit is 1 second and a larger bundle slows startup. `wrangler dev` does not report startup time, so Dom should read it from the first real deploy (steps for Dom).

What the same-Worker choice costs:

- **Deploy path.** A new Durable Object class cannot go out with `wrangler versions upload`. The first release uses `wrangler d1 migrations apply --remote` then `wrangler deploy`, the same rule O.1 records for `MachineRelay`.
- **Config in three places.** The `PI_RUN` binding goes in the top level, `env.staging` and `env.staging.previews`. The migration stays at the top level only.
- **Self calls.** The Durable Object reaches `/mcp` and `/api/proxy` over HTTP at the Worker's own origin. In `vite dev` this works. Whether a deployed Worker can fetch its own custom domain, or needs a self service binding, is not verified. A third option avoids HTTP: build the MCP tool ports in process with the run principal, the way `routes/mcp.ts` does. Settle this on staging before building (steps for Dom).

`agents/skills` cannot be imported. It pulls in `ai`, `@cloudflare/codemode` and `just-bash`, and the spike build failed with "Could not resolve" for all three. `agents/harness/pi` only imports its types, so `skills()` from there still works with a hand-written `SkillSource` (question 6).

## 2. One Pi agent for one Harbourmaster run

Yes. The flow I ran against the real local D1 database and the real `/mcp`:

1. `startRun` writes the session, run and `message.user` event and calls the adapter.
2. The prototype adapter calls `claimRun(SYSTEM_PRINCIPAL)` (run becomes `running`, lease 90 s), mints the run token with `signRunToken`, builds `mcpServers` with `buildMcpServers`, and posts the run to `PiRun`.
3. `PiRun` lists each MCP server's tools, registers them as Pi tools, creates a Pi session, and calls `submit(inputText, { operationId: runId })`.
4. As Pi commits entries, `PiRun` turns them into `message.assistant`, `tool.call` and `tool.result` events and calls `ingestRunEvents` in process. When Pi settles the submission, it calls `completeRun` with `done` and the text, or `failed` and an error.

Results (observed): "hello cloud" gave `echo: hello cloud` and finished inside the script's first one-second poll. A library `bash` call gave a `tool.call`, a `library.command` event from the platform, a `tool.result` and a final message. A model failure (Anthropic provider pointed at a closed port) ended as `run.failed` with `model_error` about 8 s after the start. Pi was set to retry three times with a 1 s base delay. In the failure case Pi's reason is coarse. The detail sits in the assistant entry's `errorMessage`, so the adapter has to copy it into the run error.

Findings that shape the adapter:

- **Session mapping.** Key the Durable Object by Harbourmaster `sessionId`. One Pi conversation per session gives the thread continuity machine runs get through `runtimeRef`. Each run is one `submit` with `operationId = runId`, and `accepted: false` on a repeat gives dispatch idempotency. I keyed by session in the real Worker but only ran one run per session. A second run in the same session is untested. It needs one change I know of: `toRunEvents` must emit only entries after that run's own user input, or the second run replays the first run's events with fresh sequence numbers.
- **Event translation must be serial.** My first version flushed from the stream callback and again at the end. Two flushes read the same `lastSeq` and wrote the same event twice (two `seq 1` rows in `events`). I serialised flushes through a promise chain. Sequence numbers come from position in the Pi transcript, so a replay after recovery is a no-op. `ingestRunEvents` itself does not defend against concurrent callers: it reads the highest `seq` and then inserts, and `events_run_idx` in `0000_init.sql` is not unique. A unique index on `(run_id, seq)` would turn the race into an error.
- **Startup race.** Lifecycle calls `onStart` before the first request has stored the session id. My first version started the reporter there with no session, and the run ended `unanswered: not_found`. Start the reporter only when both the run config and the session id exist.
- **Streaming.** `session.events()` gives a snapshot then batches, with no cursor and no replay. Harbourmaster does not need the stream to reach the browser. The UI reads `events` from D1. A raw SSE view of the stream worked in the spike (`/run/:id/sse`).
- **Cancel.** `session.abort(operationId)` withdraws a queued input or aborts the run. A tool that ignores `context.abortSignal` blocks it. I did not run the cancel path.
- **Usage.** Pi tracks usage per model and tool in its snapshot. I did not map it to `usage` on `completeRun`.

### CloudRuntime sketch

```ts
// packages/services/src/runs/cloud-runtime.ts (next to machines/runtime.ts)
interface CloudRunnerPort {                 // like MachineRelayPort: the app supplies the Durable Object
  start(input: CloudStart): Promise<void>;  // idempotent on runId
  cancel(runId: string, sessionId: string): Promise<void>;
}
export const createCloudRuntime = ({ runner, signToken, platformUrl }): RuntimeAdapter => ({
  kind: "cloud",
  dispatch: async (db, run, agent, deps) => {
    await deps.claimRun(SYSTEM_PRINCIPAL, run.id); // exists; add the agent-busy and older-run checks, see below
    const runToken = await signToken(claims(run));
    await runner.start({ run, agent, runToken,
      mcpServers: buildMcpServers({ connectors, platformUrl, runToken }) });
  },
  cancel: (db, run) => runner.cancel(run.id, run.sessionId),
});
```

`ManagedRuntime` (M8.1) has the same shape: dispatch is fast, a poller or Durable Object reports back, and both complete the run through `completeRun` as the system principal. The two can share one claim helper and the same events-in-process path.

`AdapterDeps.claimRun` already does a system-principal claim with a 90 second lease and the `run.started` event, and the prototype used it. It lacks two checks that `claimForMachine` makes in its single conditional write: no other `running` run for the same agent, and no older queued run in the same session. A session-keyed object needs both, so C.2 extends the claim with them. The sketch also leaves out `connectors` and `claims(run)`, and the release of the claim when `runner.start` fails (section 4).

My prototype reused the unused enum value `managed`. The real task adds `cloud` to `AGENT_RUNTIMES` in `packages/db/src/shared.ts`. The `runtime` column is plain `text NOT NULL` in `0000_init.sql` with no CHECK, so this is a TypeScript change and needs no SQL migration. M8.1 touches the same constant on another branch, so the two tasks should agree on the value list to avoid a merge conflict.

## 3. Tools

**Harbourmaster MCP with a run token: works.** `PiRun` calls `initialize` and `tools/list` on `/mcp` with `Authorization: Bearer hm_run_...`. It got all ten tools (`list_agents`, `send_message`, `get_run`, `list_sessions`, `read_session`, `search_sessions`, `inbox_list`, `inbox_read`, `inbox_post`, `bash`) and registered them as Pi tools named `harbourmaster_<tool>`. Pi validates arguments against the MCP JSON schema before calling. My first run sent `command` where the schema wants `script`, and Pi rejected it with a clear error. A correct call wrote `skills/_shared/shout/SKILL.md` into the library and logged `library.write` and `library.command`.

**Connectors through `/api/proxy`: works.** I seeded a connector pointing at `scripts/dev/stub-mcp.ts` and assigned it to the agent. The adapter's `buildMcpServers` gave `PiRun` a `stub` entry at `/api/proxy/<id>`. `tools/list` and `tools/call echo` both reached the stub, and the Log shows `connector.call` events with `outcome: ok`. The proxy's SSRF guard blocks `localhost` targets (`outcome: blocked`), so the stub ran behind a `cloudflared tunnel --config /dev/null` quick tunnel.

**Replay policy for MCP tools.** The bridge marks a tool `replay: "safe"` only when the MCP tool carries `annotations.readOnlyHint`. Everything else is `unsafe`: Pi does not re-run it after recovery and gives the model an "interrupted" result. Harbourmaster's read-only tools already carry the hint (`READ_ONLY` in `packages/mcp/src/tools/define.ts`, applied in `agents.ts`, `inbox.ts` and `sessions.ts`), so the bridge marks them `safe` and everything else `unsafe` with no platform change.

**Pi built-in tools.** `createCodingTools()` (`read`, `write`, `edit`, `bash`) loads in workerd, but every call fails with "No execution environment is configured". The tools call `requireEnv(api)`, and `@earendil-works/pi-durable` ships `./env/node` only, with no Workers environment. The `ExecutionEnv` interface is 24 file-system methods and 2 shell methods. Three ways forward:

- Use library `bash` over MCP for all file work. This already works and needs no container.
- Write an `ExecutionEnv` over just-bash and our R2 library (`library-fs.ts` already exists). This is medium work and still gives no real processes.
- Use Cloudflare Sandbox or Containers for anything that needs a real shell, `git`, `node` or `python`. Cloudflare's own example sidesteps the problem with `@cloudflare/computer` and a JavaScript-only backend, which needs a `worker_loaders` binding.

A harmless oddity: the tool list sent to the model includes a `__pi_deferred_placeholder__` tool. It shows up in provider request logs.

## 4. Durability

Works, with a recovery delay of about 30 seconds and two caveats.

Standalone Worker (`durability.sh`, evidence in `evidence/durability-d-*.log`): start a turn whose tool takes 12 seconds and also makes one call to the platform, `kill -9` the whole `wrangler dev` process group at 3 s, restart on the same persisted state, and send no request to the run.

| Tool replay mode | After restart | Platform side-effect calls |
|---|---|---|
| `safe` | Tool ran again, run finished "after 2 runs" | 2 (the side effect ran twice) |
| `unsafe` | Tool did not run again, model got "interrupted and may have partially run" | 1 |

Both runs completed 26 seconds after the restart, with no request touching the object. The delay is the heartbeat alarm: PiHarness schedules a 30 second wake job while Pi has work, and the alarm restarts the object.

Real Worker (`real-durability.sh`): a connector tool that takes 15 seconds, `kill -9` of `vite dev` at 6 s, restart. The run finished as `done` 31 seconds after it started, with the interrupted result for the unsafe tool. This confirms the side-effect warning: a `safe` tool may run twice, so it must be idempotent, and an `unsafe` tool never reruns but the model decides what to do with the interruption.

The lease problem (`real-lease.sh`): I killed the dev server for 100 seconds. The run's lease (90 s) expired, and the reaper (`reapExpiredLeases`, run by hand as the minute sweep would) marked the run `interrupted`. When the object came back, Pi committed another entry and the write through `ingestRunEvents` was refused with "Run is interrupted, not running". Harbourmaster had already given up on the run. A run token is only valid while its run is `running` with a lease in the future (`run-tokens.ts`). Once the lease lapses, the agent's own `/mcp` and `/api/proxy` calls are refused as well, not just the event writes. A cloud run that outlives its lease can neither report nor use tools. The cloud runtime therefore needs:

- A heartbeat that does not depend on the object being awake. My prototype used a 20 second `setInterval` inside the reporter, which dies with the object.
- A test setup where only the object is down. In my local kill test the reaper (the minute sweep) was down with it, and I ran it by hand.
- A decision on outages longer than 90 seconds: a longer lease for `cloud` runs, a reaper that skips them, or a cloud-specific check that asks the Durable Object whether it still has work.

A related finding: when the adapter's HTTP post to the Durable Object failed with a 500 during my connector test, the run was already `running` and stayed that way until the reaper took it. Claiming and starting should be one step, or `dispatch` should release the claim on failure.

Other platform behaviour from the Cloudflare example's `NOTES.md` and the docs page:

- Pi's own timers live in memory. A pending timer does not keep an object alive, so the harness hands waits over 60 seconds to the alarm.
- A single model stream over 15 minutes can be cut off. Alarm handlers have a 15 minute wall limit and the wake splits longer waits across alarms.
- Background task completion is noticed up to 30 seconds late.
- There is no approval step for tool calls, no event replay and no conversation delete.

## 5. Models

The Anthropic path works in workerd. I ran it against `mock-anthropic.ts`, a local fake Messages API on port 18798, with a fake key.

- `anthropicProvider()` from `@earendil-works/pi-ai/providers/anthropic` loads the real `@anthropic-ai/sdk` in workerd and streams. A text turn and a `tool_use` then `tool_result` turn both completed. The fake server's request records (observed, not saved) showed an `x-api-key` header (it records only that a key arrived and its length), the model id `claude-sonnet-5-5` and the full tool list.
- The credential comes from a `CredentialStore` passed to `createModels({ credentials })`. A store whose `read("anthropic")` returns `{ type: "api_key", key }` is enough. This maps directly onto the workspace key M8.1 stores with `SECRETS_KEY`: decrypt per run, hand to the store, never store it in the Durable Object. My prototype stored the whole start input, including the run token, in Durable Object storage so it could resume. The real task must keep the run token there but fetch the model key again on each wake.
- **Base URL gotcha.** Overriding `baseUrl` on the provider object does nothing. In pi-ai the base URL is request auth, so it goes in `auth.resolve()`. That is also where an AI Gateway URL would go. My first attempt reached `api.anthropic.com` with the fake key and got a 401 from Anthropic (`authentication_error`, `invalid x-api-key`), which showed that the SDK makes real requests from workerd.
- The faux provider (`fauxProvider`, `fauxToolCall`) drove every other test. Responses are derived from the transcript alone, so they stay correct after an eviction.

Not done: any authenticated Anthropic call, because no key is in `apps/web/.env.local`. Workers AI through the `AI` binding is supported by `agents/models/pi-ai` and needs no key, but it calls the remote service and I left it alone.

## 6. Skills and files

**Skills (S.1): works.** The two run-token routes (`GET /api/runs/:id/skills`, `.../skills/file?path=`) are all `PiRun` needs. The prototype lists the files, reads each `SKILL.md`, parses the frontmatter, and installs a prompt section with the catalog plus `activate_skill` and `read_skill_resource` tools. I wrote `skills/_shared/shout/SKILL.md` through the library `bash` tool, then ran a second run (a new agent and a new session) that activated it and got the body back. Skill scripts do not run, which matches the Cloudflare docs. Machine runs get the same limit for now.

Do not use `skills()` from `agents/harness/pi` as is. It returns tool results as `{ content: [...] }`. With pi-durable 1.3.0 the type is `{ output: [...] }`, and the tool result reaches the model as an empty string. I saw this in the spike: `activate_skill` returned `text: ""` and the model answered "tool said: ". The cause is a rename between pi-durable 1.1.0 (`content`) and 1.2.0 (`output`), checked in the published type definitions. The fix is the small hand-written extension in `worktree-experiment/pi/skills.ts` (about 50 lines), or pinning pi-durable to 1.1.0 with a matching pi-ai. I tried the 1.1.0 install and hit duplicate pi-ai types, so I did not go further.

**Library (F.*): works through MCP `bash`.** The agent reads and writes `/library` with the same just-bash tool machine agents use.

**Input and output files: designed, not built.** `/files/:id` and the upload routes accept a run token (`runPrincipal` in `routes/files.ts`). So `PiRun` can fetch `inputFileIds` itself. Images can go into the Pi user message as image blocks, and other files can be copied into the library or offered through a `read_input_file` tool. For output, the `[ATTACHMENT:path]` convention needs a path. In the cloud the path would be inside `/library`, and the runtime would upload the file and pass `fileIds` to `completeRun`. I did not build this.

## 7. Cost and limits

Not measurable locally: `wrangler dev` reports wall time per invocation but not CPU. The numbers below are from Cloudflare's docs and from my runs.

Durable Object limits (docs, fetched 17 Oct 2026):

- CPU time: 30 s per invocation by default, up to 5 minutes (`limits.cpu_ms`). A Pi turn spends most of its time waiting on model streams and tools, which is I/O and not CPU.
- Wall time: unlimited for HTTP and RPC while the caller stays connected. Alarm handlers get 15 minutes per invocation. PiHarness waits at most 10 minutes per alarm and then re-arms.
- SQLite storage: 10 GB per object. A row or string cannot exceed 2 MB. A tool result or model message over 2 MB may fail to store. I did not test how Pi handles one.
- Requests per second per object: soft limit 1,000.

Cost (docs): duration is billed as wall-clock time while the object is active, at its full 128 MB. At $12.50 per million GB-s that is about $0.0056 per hour of active time (0.125 GB × 3600 s = 450 GB-s), and the plan includes 400,000 GB-s a month (about 889 hours). Requests cost $0.15 per million after 1 million. SQLite rows written cost $1.00 per million after 50 million. A 10 minute turn costs about $0.001 in duration. Model tokens dominate the bill by orders of magnitude.

Measured locally: a faux turn with one MCP call finishes in about 1 to 2 seconds including three HTTP hops. A tool that waits 12 seconds shows up as one 12.5 second alarm span. Recovery after a hard kill took 26 seconds from the restart in the standalone Worker. In the real Worker the run finished 31 seconds after it started, with the kill at 6 s and about 6 s for `vite dev` to come back.

Compared with Claude Managed Agents (docs, fetched 17 Oct 2026; beta, header `managed-agents-2026-04-01`):

| | Pi on a Durable Object | Managed Agents |
|---|---|---|
| Model tokens | Standard Anthropic rates, our key | Same rates |
| Runtime charge | About $0.0056 per active hour | $0.08 per session-hour while `running` |
| Shell, files, web search | None. Library `bash`, MCP and connectors only | Built in, in a managed cloud sandbox |
| Where state lives | Our Durable Object SQLite | Anthropic, server side |
| Data retention | Ours | Not eligible for zero data retention or BAA |
| Models | Any pi-ai provider, Workers AI included | Claude only |
| Maturity | Beta wrapper over an experimental library | Beta API |

These two are not substitutes. Managed Agents gives an agent a computer. A Durable Object gives it a cheap, durable loop with no computer. M8.1 and this runtime can both ship, and the agent form picks per agent.

## Proposed tasks

If Dom says go. Sizes are S, M and L as in the build plan.

| Id | Title | Size | Check |
|---|---|---|---|
| C.1 | Pin and wire Pi. Add `agents` 0.28.1 exact, `pi-durable` and `pi-ai` exact, `typebox`. Add `PI_RUN` to the top level, `env.staging` and `env.staging.previews`, migration `v2`. Add a bump test that asserts the tool-result shape pi-durable expects. | S | `bun run check`, `bun run test`, `bun run build` pass. Drizzle grep passes. Dry-run bundle well under 64 MiB, and Worker startup under 1 s on staging. |
| C.2 | `CloudRuntime` adapter. Add `cloud` to `AGENT_RUNTIMES` (agree the list with M8.1), extend `claimRun` with the agent-busy and older-run checks, release the claim when the start fails, `CloudRunnerPort`, agent form option. | M | Unit tests against a fake runner: dispatch, claim race, failed start releases the run, cancel. |
| C.3 | `PiRun` Durable Object keyed by session. Event translation sliced per run, serial flush, complete and fail with the model error text, usage mapping, cancel, steer for a second message in a busy session. | L | Faux-provider tests in `wrangler dev`: two runs in one session, duplicate dispatch, abort, model failure. No duplicate `seq` rows. |
| C.4 | Lease, heartbeat and run token for cloud runs. Heartbeat from an alarm owned by the runtime, plus a rule for outages over the lease (longer lease, reaper skip, or a Durable Object liveness check). The rule must also keep the run token valid, since tokens die with the lease. | M | Kill test with the sweep still running: object down for 120 s, run ends `done` and not `interrupted`, tool calls after recovery succeed. |
| C.5 | MCP bridge hardening. Reconnect when a tool list changes, since a session fixes its tools at creation. Decide in-process tool ports versus a self service binding. | M | Tool call through `/mcp` and `/api/proxy` in a deployed staging preview. |
| C.6 | Workspace model key. Read the decrypted key per run from the M8.1 secrets store, pass it through a `CredentialStore`, keep it out of Durable Object storage. Model list for cloud agents. | M | Test with a fake Messages server asserting `x-api-key`. Live check with a real key (Dom step). |
| C.7 | Skills and input files for cloud runs. Productise `skills.ts` and add input file fetch and image blocks. Output files via library upload and `fileIds`. | M | Run with a seeded skill and an attached image on staging. |
| C.8 | Execution environment (optional, later). Either a just-bash backed `ExecutionEnv` so Pi's `read`, `write`, `edit` work on the library, or a Sandbox backed shell. | L | Pi's built-in `read` and `edit` change a library file. |
| C.9 | Durability suite. `kill -9` script from this spike turned into a repeatable check for safe, unsafe and long-outage cases, run on every Pi version bump. | S | Script exits 0 on the pinned versions. |

C.1 to C.4 are the first slice. C.5 and C.6 are needed before real use. C.7 and C.8 can wait.

## Steps for Dom

1. Say go or no-go on the conditional go above. The two decisions that matter are the exact version pins and whether `cloud` agents are limited to library `bash`, connectors and skills at first.
2. Put an `ANTHROPIC_API_KEY` in `apps/web/.env.local` if you want the live check, then run `real-run.ts --model anthropic` without `--anthropic-base` from the spike folder. The prototype code only passes a fake key today, so this also needs a one line change to read the key from the env file. I did not do it, to keep the key out of the prototype.
3. Do one staging deploy of the spike branch with `wrangler d1 migrations apply --remote` then `wrangler deploy`. Check three things: the first deploy reports a Worker startup time under 1 second with the larger bundle, a `PiRun` Durable Object can fetch the Worker's own `/mcp` (public origin or a self service binding), and `wrangler tail` shows CPU time per invocation for one real turn.
4. Agree the `AGENT_RUNTIMES` list with M8.1 so the two tasks do not conflict on `packages/db/src/shared.ts`.

## Reproduce

From the spike folder, with the C.0 worktree installed (`bun install`):

```
./node_modules/.bin/wrangler dev --port 8799 --persist-to .wrangler-state    # standalone Worker
./durability.sh slow-safe d-safe        # and slow-unsafe
bun mock-anthropic.ts                    # fake Anthropic API on 18798
```

For the real Worker, apply the patch in `worktree-experiment/`, run `bunx wrangler d1 migrations apply DB --local` and `bunx vite dev --port 3917` in `apps/web`, then `bun real-run.ts --server http://localhost:3917 --text "bash ls /"` from the worktree root.
