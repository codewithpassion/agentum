# C.14 review

Task: Linux VM backend for cloud agents on the Sandbox SDK. Branch task/C.14-cloud-linux-vm.

## Verdicts

- Round 1 at 9d22dd8 was must-fix, with 2 must-fix and 19 nits. A timed out command exited 137 and never 124, because `timeout -s KILL` kills its own group. A restarted Durable Object also lost the container's inactivity timeout.
- Round 2 at 4e8db23 was must-fix with 1 item. Both round 1 items were fixed, but the last-resort abort fired at timeoutMs plus 3 s, before `timeout -k 2` could send KILL.
- Round 3 at 53e3273 was must-fix with 1 item. The abort timing was right, but a new guard that skipped the abort for an exited process made `exec` hang when a command left a background child holding its output pipes.
- The last commit on the branch removes that guard. A command that has exited now returns within 1 s (`STREAM_DRAIN_MS`) with its exit code and the output so far, and the abort stays a last resort for a command that is still running. It has a test. No reviewer has seen it, because the loop allows two fix rounds.

## What was built

The container class is `VmSession`, on the Durable Object scheduling policy. `wrangler.jsonc` has it at the top level and in `env.staging`, with the image `apps/web/container/Dockerfile` (node 24, bun 1.3.11 and the `sandbox-shim` of `@cloudflare/sandbox` 1.0.1), the binding `LINUX_VM`, migration `v4` and the var `LINUX_VM_IDLE_SECONDS`. `env.staging.previews` gets only the binding and the var, because wrangler 4.151 refuses `scheduling_policy: "durable_object"` there. A Linux VM agent therefore fails in a preview with "VmSession needs a container", and isolate agents are unaffected.

The agent setting is `runtimeConfig.environment`, either `isolate` (the default) or `linux-vm`. It lives in `packages/services/src/cloud/environment.ts`. The agents service refuses an unknown value and an environment on a non-cloud agent. The agent form has an Environment field that explains the trade-off.

`apps/web/src/server/linux-vm/` holds the rest.

- `vm-port.ts` is the `LinuxVm` port, and `fake-vm.ts` is the test fake behind it.
- `vm-core.ts` has the start, restore, idle alarm, snapshot, destroy and exec logic. It imports nothing from Cloudflare and is tested with fakes.
- `vm-session.ts` is the Durable Object over `ctx.container`, the SDK's `Files` and `DirectoryBackup`. `durable-vm.ts` is the port over its stub.
- `vm-env.ts` is an `ExecutionEnv` over the port, so Pi's `read`, `write`, `edit` and `bash` run in the VM. `vm-tools.ts` and `environment-tools.ts` decide which tool set a session holds.
- `vm-skill-sandbox.ts` runs `run_skill_script` through C.12's port with `bun <file>` in `/workspace`. `vm-workdir.ts` places skills in `/workspace/skills` and input files in `/workspace/input`.

`PiRun` switches by the agent's `runtimeConfig` at each run start. It places skills when the run's skills load and input files when the message is built, and the message says where the input files are.

The VM starts on its first call and restores the last snapshot. After `LINUX_VM_IDLE_SECONDS` (180) with no call and no running command, an alarm snapshots `/workspace` to the `FILES` bucket under `vm-snapshots/` and destroys the container. The old snapshot object is deleted once the new one is stored. Commands run under `timeout -k 2 <seconds>` with `HOME` and only the variables they are given, never one of ours. The bash tool allows 120 s by default and 600 s at most, and a skill script gets 30 s. Output is capped at 1 MiB for a shell command and 64 KB for a skill script.

`@cloudflare/vite-plugin` moved from ^1.26.0 to ^1.64.0 and wrangler from ^4.147.0 to ^4.151.0. The old plugin bundled wrangler 4.124, which rejects Durable Object containers. The bump also moves workerd and miniflare to 20261012. The Pi pins did not change, so `e2e:pi-durability` was not run.

## Checks

- Unit tests put the VM behind the port with a fake behind it. They cover environment selection and the registry swap in both directions, file placement, snapshot and restore calls, a failed restore, the idle alarm, a busy VM, snapshot failures, the time and output caps, a command that leaves a background child, the ExecutionEnv, Pi's real `read`, `write`, `edit` and `bash` tools through a Harness with a faux model, and `run_skill_script` through the VM sandbox.
- `bun run check`, `bun run test` and `bun run build` pass, and the bundle grep for `drizzle` finds nothing.
- Live on a local dev server with a Clerk dev login, the workspace key stored through `managedKeys.set` and Haiku, an isolate agent with the skill `ts-hello` ran `hello.ts` and printed the codeword `REIP-3024` for `pier`. `probe.ts` fetched https://example.com and got `status: 200`. The isolate path works as before.
- The Linux VM live check did not run. It covers `uname -a`, `bun --version`, `ts-hello`, a `node:fs` file that survives a sleep, and a fetch of example.com. On this host (Docker 29.2.1, kernel 7.0.0-31) `wrangler dev` and `vite dev` never start a user container. The `proxy-everything` networking sidecar starts and workerd sends it `PUT /egress`. The connection through the published port is reset, and a request to the container's IP gets no answer. Workerd then never issues `POST /containers/create` for the user container and logs `kj/timer.c++: operation timed out`. A bare probe project fails the same way, with the get-started `durable_object` shape, the `default` policy, `cloudflare/debian-trixie`, wrangler 4.124 and 4.151, and proxy tags 3cb1195 and 510e5ce. So the cause is not this code. The VM path is checked only against the SDK types and the Cloudflare docs, and the staging check is its first run against a real container.

## Nits left

1. `lastActivity` and `busy` in `vm-core.ts` live in memory, so a restarted object counts idle time from its restart. After three failed snapshots the VM is destroyed and everything since the last good snapshot is lost, with only a `console.error`. A command that exits 124 by itself is reported as a timeout.
2. The timeout test relies on the platform reporting 137 when `timeout` is killed by SIGKILL. Cloudflare's docs say not to infer an exit code from a signal. Check on staging, or decide on elapsed time alone.
3. When the prepared mark is missing, `vm-core.ts` restores the snapshot again into a container that may hold a partial restore. If that second restore fails, the key is deleted and the old object stays in R2.
4. `vm-env.ts` ignores the run's abort signal once a command has started, so cancelling a run does not stop a command of up to 10 minutes. The wall time still ends it.
5. Snapshots under `vm-snapshots/` are not deleted when a session or workspace goes away, and they sit outside the per-workspace key layout of the bucket.
6. `placeSkills` runs on every run start, so a Linux VM agent starts and pays for its container even for a reply that uses no tools. `placeInputFiles` makes names unique within one call only, so a later run's `a.txt` replaces the earlier one.
7. `withPlacedPaths` adds nothing when a message is an array with no text block. The `description` fields in `CLOUD_ENVIRONMENTS` are unused, because the form has its own text.
8. `SCRIPT_LIMITS.graceMs` is now 6 s for both backends, up from 2 s. After a cold VM start the skill-script safety net can still fire before the VM's own wall time, because file placement and the start come before the VM's clock.

## Ideas beyond the scope

- Files the agent writes in the VM do not reach the user, because `[ATTACHMENT:path]` markers are uploaded from the library only. A tool or marker that uploads from `/workspace` would close that.
- An allowlist proxy for the VM's network, which the task leaves out for this slice.
- A separate R2 bucket for snapshots with a lifecycle rule, and snapshot deletion when a session is archived.
- A terminal view of the VM for debugging, as the Cloudflare template has.
- Start the VM on the first tool call instead of at run start.

## Steps for Dom

- Turn on Containers for the account that `wrangler deploy` uses. Docker must run on the machine or the build that deploys, because the deploy builds `apps/web/container/Dockerfile` and pushes it.
- The first deploy of `env.staging` and of production creates the `VmSession` class through migration `v4`, so it goes out with `wrangler deploy` and not `versions upload`. The Durable Object scheduling policy is beta, and it cannot be changed once the container application exists.
- Snapshots land in the `FILES` bucket (production) and `harbourmaster-staging-files` (staging) under `vm-snapshots/`. Add an R2 lifecycle rule on that prefix, for example expiry after 7 days, because snapshots of gone sessions are not deleted.
- Staging check after deploy. Create a cloud agent with Environment "Linux VM" and Haiku, and put the `ts-hello` skill from `docs/reviews/tasks/C.12.md` in the library under `skills/<agentId>/ts-hello/`. Ask it to run `uname -a` and `bun --version` in its shell, then for the `ts-hello` codeword. Ask it to run a script that uses `node:fs` to write a file. Wait longer than `LINUX_VM_IDLE_SECONDS` (180 s) so the VM sleeps, then send a second message that reads the file. Last, ask it to run `fetch("https://example.com")` and report the status. An isolate agent should behave as before.
- If a command that times out shows exit code 137 and no "timed out" note on staging, the platform does not report what nit 2 assumes.
