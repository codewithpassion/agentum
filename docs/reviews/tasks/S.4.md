# S.4 review notes

Secrets in the cloud agent Linux VM. Branch task/S.4-vm-secrets.

## Verdicts

- Round 1 at 49723c4 was clean, with 14 nits and four things that only staging can check. Three nits were fixed after the review (the CA wait now needs a non-empty file, the routing warning logs the error name only, a comment). The rest are listed below.

## Spike: how a Worker intercepts a container's traffic

Checked against the Cloudflare docs on 17 Oct 2026 (Containers "Handle outbound traffic" and "Durable Object Container API", Sandbox "Call an authenticated API from a sandbox").

- `cloudflare/claude-managed-agents` and the Sandbox SDK use outbound Workers. For the `Container` class they are static `outbound` and `outboundByHost` handlers with `interceptHttps = true`. VmSession is not a `Container` class. It is a plain Durable Object with `ctx.container` (the scheduling policy C.14 chose), and for that the docs give the direct API, which is the same mechanism underneath.
- `ctx.container.interceptOutboundHttps(host, entrypoint)` routes HTTPS requests for a hostname or a `*.` glob through a `WorkerEntrypoint` stub. `interceptOutboundHttp` does the same for port 80, and `interceptAllOutboundHttp` takes all of port 80. The entrypoint runs in the Workers runtime outside the container, so it can hold secrets the container never sees. It is the `SecretsOutbound` entrypoint from S.3, made with `ctx.exports.SecretsOutbound({ props })`, so the isolate and the VM share one implementation of the header rules, the https-only rule, the scrub of answers and the `secret.injected` event.
- Intercepts last until the container stops, so they are registered again for each new container. Registering a host again replaces its handler. A container holds at most 128 intercept entries, 64 hostnames, and a hostname uses two.
- HTTPS interception creates an ephemeral CA in the container at `/etc/cloudflare/certs/cloudflare-containers-ca.crt` once the first HTTPS intercept exists. The container has to trust it. The Sandbox class does that by itself. For `ctx.container` the code must: copy the file into the system store and run `update-ca-certificates` (curl and git then trust it), and set `NODE_EXTRA_CA_CERTS` for Node and Bun.
- A hostname intercept registered after a catch-all never receives requests, and `DirectoryBackup` registers its own gateway host. S.4 registers only specific hosts and no catch-all, so neither problem applies.

## What was built

`proxy` secrets. At run start `PiRun` reads the host names of the agent's `proxy` rules and calls `LinuxVm.setEgress({ hosts, run })` on the session's VM (`run` is agent, run and workspace ids). The Durable Object stores that, registers `interceptOutboundHttps` for each host with the entrypoint made for that run, waits for the CA, trusts it once per container, and from then on gives every command `NODE_EXTRA_CA_CERTS`. A cold start after the VM slept applies the stored routing again. The intercept is for the hosts of rules only, so an agent with no `proxy` secrets, and every host without a rule, behaves exactly as in C.14 (no MITM, no CA). A request to a rule host reaches `SecretsOutbound`, which adds the header, passes redirects back to the script, scrubs the answer and records `secret.injected`. No value, header or rule text crosses the Durable Object boundary. The VM, its exec calls and its storage hold ids and host names only.

`env` secrets. The bash tool's `ExecutionEnv` (`vm-env.ts`) and the skill script sandbox (`vm-skill-sandbox.ts`) pass the agent's granted `env` secrets as the command's environment. The values are read for each command, so a changed grant applies at once, and a failed lookup stops the command (it never runs without its secrets or without masking). The command's stdout and stderr are masked with the same masker as S.3 before the model sees them, and the runs service masks the events it ingests, so the transcript and the Log hold `[secret:NAME]`. Each command records `secret.delivered` with names only.

Other changes. `secretsForEnvironment` is gone, since the VM now gets secrets. `BUN_*` is a reserved secret name prefix (C.14 nit 8, because Bun reads its settings from the environment). The prompt sections for the VM say that granted secrets are environment variables and that credentials for proxied hosts are added by the platform.

## Checks

- Unit tests behind the ports: the core's routing and CA trust (cold start, repeat call, empty hosts, sleep and wake, failed intercept, failed trust, no network dep), the CA variable only after trust, `createVmEnv` with and without secrets (env merge, masked stdout and stderr, a failed lookup does not run the command), the skill sandbox and `run_skill_script` through the VM with a grant, a proxy-only grant and no grant, the reserved names. `bun run check`, `bun run test` and `bun run build` pass, and the bundle grep for `drizzle` finds nothing.
- The live check in the task (a VM script and a `curl` reach the echo server with the header) did not run. The local VM cannot start on this host (see C.14), so the VM side is checked only by the unit tests and the Cloudflare docs. The staging steps below are its first real run.

## Known and accepted leak paths for `env` mode

Dom cut the scope on 17 Oct 2026: `env` mode in the VM is simple and less secure is fine for now. A script or the model, with a shell in the VM, can therefore get an `env` secret's value by these routes, and they are accepted:

- Files in `/workspace`. A command can write the value into a file (`echo $KEY > x`). `read` and `bash cat` show the file unmasked to the model, and the value goes into the R2 snapshot. The runs service still masks the events it stores, so the transcript and Log show `[secret:NAME]`, but the model has seen the value.
- Background processes. A process started with the variable keeps it, and it can keep writing it after the call that started it.
- `/proc`. Any command can read `/proc/<pid>/environ` of a process it owns, and `env` of a later command in the same shell is masked only because the masker sees the output.
- The R2 snapshot of `/workspace` holds whatever a command wrote there.
- Output that is cut at the byte cap before it is masked (nit 1 below) can leave the first characters of a value that straddles the cut.
- Anything the script sends to a host it controls: `env` mode means the code can read the variable.

`proxy` mode has none of these: the value never enters the VM, a request, a file or a process in it.

## Nits left

1. `vm-core.ts` caps stdout and stderr at 1 MiB (64 KB for a script) before `vm-env.ts` and `run-skill-script.ts` mask them. A value that straddles the cut leaves its first characters in the output. S.3 masks before it caps.
2. If one `interceptOutboundHttps` call fails (for example at the 64 hostname limit), the others have registered, the CA is not trusted, and the same happens on each cold start. A failed trust step during a start only warns, and nothing retries it until the next run's `setEgress`. Both fail closed (the TLS handshake fails, no credential is sent).
3. Routing is set up only in `#loadAndInstallSkills`, so a run whose skills fail to load gets none. `resolveForAgent` decrypts every granted value to read host names. A hosts-only read would keep the values out of memory.
4. A `setEgress` call with no hosts changes nothing, so after the last proxy secret is revoked the old intercepts stay until the container stops. The entrypoint finds no rule and passes the request through unchanged, but it carries the old run id and the CA trust still runs on a cold start.
5. `vm-env.ts` calls the secrets lookup for every bash command, so each command adds a `secret.delivered` event and a decrypt.
6. `setEgress` runs outside the start and sleep turn, so a command that is running at the same time can miss `NODE_EXTRA_CA_CERTS` while the intercept goes live.
7. `SECTION_TEXT` says that granted secrets are environment variables even for an agent with none, and says that they show as `[secret:NAME]`, which is not true for what `read` shows from a file. The VM's `plain` script text is no longer used.
8. The reserved secret names still miss `SHELLOPTS`, `BASHOPTS`, `PS4`, `BASH_XTRACEFD`, `NPM_CONFIG_*`, `GLIBC_TUNABLES`, `GCONV_PATH`, `LOCPATH` and `SSLKEYLOGFILE`. Names are checked when a secret is written, so one stored with a `BUN_` name before this change is still delivered.
9. `SecretsOutbound` buffers answers up to 10 MiB, so a large download from a proxied host returns 502 and server-sent events do not stream. It is a limit on what works, not a leak.
10. There are no unit tests for `PiRun.#routeVmEgress` or for VmSession's intercept wiring, since both need a Worker runtime.

## Ideas beyond the scope

- Mask before the cap, by passing the masker into the VM port (`maskFor(env)` on `exec`).
- A hosts-only query on the secrets service (`proxyHostsFor(workspace, agent)`) for the routing.
- Native `proxy` rules with the CA setup moved into the image's entrypoint, so the trust step is not a runtime exec.
- A catch-all intercept with an allowlist, to give the VM a network policy (C.14 idea).
- An `env` mode that hides the value as Managed Agents do (placeholder in the VM, swap on outbound) now that the outbound entrypoint is in place for the VM. It would make `env` and `proxy` the same mechanism with a different header rule.

## Steps for the controller, on staging

Nothing needs a new binding, migration or secret. The image is unchanged, so no container rebuild is needed beyond the Worker deploy (VmSession gets new methods; deploy `env.staging` with `wrangler deploy`, not `versions upload`, as in C.14).

1. Make an echo server reachable from the internet over HTTPS (a cloudflared quick tunnel with `--config /dev/null`, as in S.3) that returns the request headers.
2. In the staging workspace, create a `proxy` secret `ECHO_KEY` with a rule for the tunnel's host and the header `x-echo-key: {value}`, and an `env` secret `PLAIN_KEY`. Create a cloud agent with Environment "Linux VM" and Haiku, grant both secrets, and put a skill with a script that fetches the tunnel URL (`fetch(url)` and prints the echoed headers) in the library, as the `ts-hello` skill of C.12.
3. Ask the agent to run the script, and to run `curl -s https://<tunnel host>/` and `env` in its shell. Expect: both calls reach the echo server with `x-echo-key` set. `env` shows `PLAIN_KEY=` as `[secret:PLAIN_KEY]`, and shows no `ECHO_KEY`. `echo $PLAIN_KEY | wc -c` in the shell gives a length greater than zero (the variable is readable). The transcript and Log show `[secret:...]` and never a value. `secret.delivered` and `secret.injected` events are in the run.
4. Check first: a proxied request must reach the echo server with the header and not fail with 403 "added to https requests only". If it does fail, the entrypoint receives `http:` URLs from the HTTPS intercept and the https check in `secrets-outbound-core.ts` needs to know that.
5. Also check: `bun -e 'console.log((await fetch("https://<tunnel host>/")).status)'` (Bun trusts `NODE_EXTRA_CA_CERTS`), `git ls-remote` or `curl` to the host (system store after `update-ca-certificates`), a request to a host with no rule (unchanged, no MITM), and an agent with no grant (no env, no intercepts).
6. Let the VM sleep (more than 180 s), send a second message and repeat step 3. The routing must come back with the new container.
7. A deploy while a container runs may leave its intercepts pointing at the old `SecretsOutbound`. The Sandbox SDK registers intercepts again when a restarted Durable Object finds a running container, and this code relies on the `prepared` mark instead. If a proxied request fails after a deploy with a warm VM, wait for the VM to sleep or send a new run (`setEgress` runs again at each run start).
