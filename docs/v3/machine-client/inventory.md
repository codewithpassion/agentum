# One Rust machine client: inventory of what it replaces

Read-only investigation of `/home/roboto/devel/harbourmaster-wt/deploy-ep` at `e29151e7` (Merge PR #8), 2026-11-05.
Paths are repo-relative. "(inferred)" marks anything not read in code.

Detail files next to this one, each with file:line references:
- `daemon.md`: apps/daemon (TS, `agentum`, role `agent_host`)
- `computer.md`: apps/computer (Go, `hm-computer`, role `computer`), about 440 lines, the most detailed
- `server.md`: server contract, roles, release pipeline

This file is the summary and the cross-client comparison. Where it is short, the detail file has the rest.

---

## 1. Feature parity inventory

### 1.1 Commands and flags

| | daemon `agentum` (apps/daemon/src/main.ts) | computer `hm-computer` (cmd/hm-computer/main.go) |
|---|---|---|
| enrol | `enroll <code> --server <url> [--claude <path>]` (code is positional) | `enroll --url <u> --code <c> [--code-stdin] [--name] [--state-dir] [--desktop] [--log-format]` |
| run | `run` (no flags) | `run` with 20 flags: `--url --code --code-stdin --name --state-dir --workdir --allow-root --read-only --workdir-only --max-concurrent 4 --max-queue 32 --max-exec-seconds 1800 --max-file-bytes 256MiB --log-format json --audit-max-bytes 8MiB --audit-keep 3 --desktop --desktop-display 99 --allow* --deny* --allow-env*` (serve.go:39-61). `run --code` enrols on first start. |
| status | `status` (text) | `status [--state-dir] [--json]` (status.go) |
| service | `install-service [--claude <path>] [--refresh]` | none. A hand-installed system unit (packaging/hm-computer.service) |
| version | `-v`/`--version` | `version`, `--version`, `-v` |
| help | `-h`/`--help` exit 0 | `help`/`-h` exit 0, subcommand `--help` exits 2 (Go flag) |
| arg parser | node `parseArgs` strict, `--flag` only | Go `flag`, accepts `-flag` and `--flag` |

Env vars. Daemon reads only `HM_DAEMON_VERSION` (a build-time define, version.ts:20) and `USER` as a fallback, and passes a filtered env to claude (agent-env.ts). The SDK reads `DEBUG_CLAUDE_AGENT_SDK`. Computer reads `HM_URL`, `HM_ENROLL_CODE` (it unsets this after use, enroll.go:140), `HM_STATE_DIR`, `USER`, and `PATH`/`HOME`/`LANG` for the command env.

### 1.2 Exit codes

| code | daemon (exit-codes.ts) | computer (main.go:19-25) |
|---|---|---|
| 0 | ok, also stopped by a signal | ok, also stopped by a signal |
| 1 | any failure, including usage errors | runtime failure |
| 2 | linger missing (install-service only) | usage error, run as root, not enrolled with no code |
| 3 | relay closed with 4401 (credential rejected) | relay closed with 4401 (revoked) |
| 4 | none | `status`: not enrolled |

Both use 3 for "enrol again". Exit 2 means different things in the two clients. The daemon unit sets `RestartPreventExitStatus=3`. The computer unit sets `Restart=always` with no prevent, so a revoked computer restarts every 5 s.

### 1.3 Enrol

- Both call `POST /api/machines/enroll` with no auth. The code is single use and lives 15 min (services/src/machines.ts:55, 356-372).
- Daemon body: `{code, singleUser}`. Computer body: `{arch, clientVersion, code, hostname, os, role:"computer"}` (packages/protocol/src/machine.ts:62-87). The server validates the computer fields and then drops them (server.md section 2).
- Response for both: `{credential, machineId}`. There is no machine name in it.
- Both clients accept `ag_` and `hm_` token prefixes (config.ts:25 through `MACHINE_CREDENTIAL.matches`, enroll.go:151). The server still issues `hm_` (token-prefixes.ts:55-65), so the Rust client must accept both.
- Differences:
  - URL checks. The daemon checks `z.url()` and strips trailing slashes. The computer refuses plaintext except for loopback and refuses redirects (serverurl.go, enroll.go:113-123).
  - Code input. The daemon takes the code in argv, where `ps` shows it. The computer takes `--code`, `HM_ENROLL_CODE` or `--code-stdin`.
  - `singleUser`. The daemon probes `sudo -k -n -u hm-agent <claude> --version` to decide it (enroll.go:62-64).
  - Platform strings. The computer sends Go's names (`linux`, `darwin`, `amd64`, `arm64`).

### 1.4 State, config and credential storage

| | daemon | computer |
|---|---|---|
| dir | `~/.agentum/` 0700 (legacy `~/.harbourmaster/`) | `$HM_STATE_DIR`, else `~/.hm`, else `/var/lib/hm-computer`. 0700, refuses a dir owned by another uid (state.go:57-92) |
| credential | inside `config.json` | separate `credential` file 0600, plain text |
| config | `config.json` 0600 `{claudeBinary, credential, machineId, server, singleUser}`, strict zod, atomic tmp+rename (config.ts) | `config.json` 0600 `{url, machineId, name?, desktop?}`, atomic |
| other state | work dirs `~/agentum/<ws>/<agent>/work`, or `/home/hm-agent/agentum/...` in multi-user mode (workdir.ts). Per run it wipes `.claude/ .mcp.json inbox/ tmp/` and keeps `library/` and `library.manifest.json` | `audit.jsonl` (rotated), `running/<pgid>.json` process-group records, `sessions/` workdir, `desktop/Xauthority`, `desktop/chromium-profile/` |
| keyring | none | none |

Neither client supports more than one instance. The daemon fixes the config path, the unit name `agentum` (install-service.ts:31) and one shared `hm-agent` user. Its work dirs are keyed only by workspace and agent, so two instances that serve the same workspace would share dirs. The computer can be pointed elsewhere with `--state-dir`, but `--desktop-display 99` and the display lock `/tmp/.X99-lock` collide between instances.

### 1.5 Connection, heartbeat, reconnect

| | daemon (client.ts, backoff.ts) | computer (internal/conn) |
|---|---|---|
| socket | `wss://<server>/api/machines/connect` | `wss://<server>/api/machines/computer` |
| auth | `Authorization: Bearer <hm_mach_…>` | same, separate credential |
| hello | `{type:"hello", agents:[], capabilities:{agentSdk, container:false}, daemonVersion, features:[library-sync, requests, library-live, current-approvals]}` | `{type:"hello", protocol_version:1, hostname, os, arch, version, run_as_user, workdir, capabilities:{python3, git, skills, desktop, desktop_unavailable_reason}}` |
| heartbeat | JSON `{type:"ping", at}` every 20 s, no pong. hello_ack timeout 40 s | bare text `ping` every 10 s. The server answers `pong`. Two misses close with 1008, read deadline 25 s |
| backoff | 1 s·2^n, cap 60 s, jitter ×[0.8,1.2]. Resets after 30 s stable past hello_ack | uniform [c/2, c], c = 1 s·2^step, cap 60 s. Resets after a 60 s session. 401, 4400 and 4409 wait 5 min + [0,150 s) |
| terminal | 4401 → exit 3 | 4401 → exit 3. An HTTP 401 on upgrade is not terminal |
| replaced | 1012 → abort all runs, normal backoff | 4409 → slow retry, commands keep running |
| server liveness | offline after 90 s of silence | stale after 25 s, presence alarm every 60 s |

Version reporting matters. The server flags "Daemon update available" whenever the hello's `daemonVersion` differs from `latest.json` by exact string (machine-logic.ts:65-79). `capabilities.agentSdk` is stored as an opaque string (relay-core.ts:248), so Rust can report e.g. `claude-cli@2.1.318`.

### 1.6 Runs and executor (daemon only)

- Relay frames: `offer{agentId,runId}`, `cancel{runId}`, `library_changed{paths}`.
- Concurrency: one run per agent at a time, with a queue per agent. Different agents run in parallel, and a repeated offer is ignored (run-manager.ts).
- HTTP routes with the machine credential, under `/api/machines/runs/<id>/`:
  - `claim` sends the `X-Daemon-Features` header.
  - `events` takes batches of up to 100 every 500 ms, with seq numbers from 1.
  - `heartbeat` runs every 20 s against a 90 s lease. A 409 aborts the run.
  - `complete` takes `done`, `failed` (with an optional `stop`) or `aborted`. A 409 on `aborted` is accepted.
  - `requests` raises a request, and `requests/<id>?wait=25` long-polls it.
  - `needs-approval` asks whether a tool needs approval.
  - Each call times out after 30 s.
- Per run:
  1. Prepare the work dir.
  2. Sync skills into `.claude/skills/`.
  3. Sync the library in.
  4. Download input files to `inbox/`.
  5. Start `query()`, hand over MCP servers, then send one user message.
  6. Stream events.
  7. On a result, close stdin.
  8. Wait for exit (SIGTERM, then SIGKILL after 5 s).
  9. Final library sync out.
  10. Complete.
- The last 500 chars of stderr go into the failure message.
- The machine credential, run token and agent secrets are masked in every body and log line (`@repo/protocol/masker`).
- SIGINT/SIGTERM: every run ends as `aborted`, then exit 0.
- Session resume uses `claim.session.runtimeRef`, and only when `runtimeMachineId` equals this machine (executor.ts:162-168).

### 1.7 Approvals (daemon only, approvals.ts)

- The decision is made by a PreToolUse hook with a 25 h timeout.
- `canUseTool` always allows. It exists only so the CLI offers AskUserQuestion (spike notes at approvals.ts:3-15).
- The rules come from `claim.toolRules`, or from live `needs-approval` calls when `currentApprovals` is set.
- AskUserQuestion becomes a `question` request, and the answers go back through `updatedInput.answers`.
- Transient failures (status 0, 408, 429 or 5xx) are retried 10 times with backoff, then the call is denied. It fails closed.
- Shared TS logic the client relies on: `toolKey`, `approvalSummary`, `outcomeText` and `askUserQuestionAnswers` from packages/protocol/src/requests.ts (346 lines).

### 1.8 Files

- Daemon, for runs only, with the run token:
  - `GET /files/<id>` downloads input files.
  - `POST /api/files` uploads (multipart, field `file`). It is implemented in files-api.ts, but nothing calls `upload` (grep), and the completion never sends `fileIds`. Output files reach the user through the library task folder.
  - Timeouts are 120 s.
- Computer, as protocol ops over the socket:
  - `file_put`: 256 KiB chunks, an ordering window of 32, at most 8 open uploads, temp file then rename with the destination's mode carried over, sha256 checked.
  - `file_get`: stateless windows, sha256 on offset 0.
  - Path policy: the state dir is always refused, `--workdir-only` confines to the workdir, `--read-only` refuses writes. Details in computer.md section 7.

### 1.9 Library sync (daemon only)

- Code: library-sync.ts plus `@repo/library-sync` (about 600 lines of logic in sync-in, sync-out, coalesce and files). The same package also serves the Linux VM.
- Routes: `/api/runs/<id>/library/{list,stat,file GET/PUT/DELETE,conflicts}` with etag compare-and-swap. Files are capped at 10 MB.
- A lost race is saved as `<path>.conflict-<runId>`.
- Watching:
  - Single-user: an `fs.watch` per folder pushes edits.
  - Multi-user: checkpoints only, every 5 min, because the daemon user cannot watch hm-agent's dir.
- Read and write roots come from the claim. `library_changed` frames pull changed paths in.

### 1.10 Computer commands (computer only)

- How commands run: `/bin/sh -c`, in a new session (setsid). Timeouts and cancels SIGKILL the whole process group. Exit codes: 124 for timeout, 127 for start failure, 137 for cancel, 128+n for a signal.
- Output is capped at 512 KiB per stream, as head + marker + tail.
- Env: a minimal scrubbed env, plus the request env filtered by the policy (`LD_*` and `DYLD_*` are always refused).
- Policy flags: `--allow`, `--deny`, `--allow-env`, `--read-only`, `--workdir-only`.
- Orphans: process groups are recorded in `running/` and swept at start and shutdown, but only after a start-time check.
- Audit: `audit.jsonl` with rotation.
- Commands survive a reconnect, and a reply is never sent on a newer socket.
- Full detail: computer.md section 6.

### 1.11 Desktop (computer only, Linux only)

- Components: Xvfb `:99` 1280x800x24 with no TCP, openbox, xdotool (XTEST, inferred) for input, xclip for the clipboard.
- Screenshots: in-process X11 GetImage, encoded as JPEG.
- Xauthority is written in-process.
- Health checks: a Chromium sandbox self-test runs at start. Xvfb and openbox are supervised with backoff.
- Failure is never fatal. It is reported in hello as `desktop_unavailable_reason`.
- The Chromium wrapper and seccomp profile ship only in the Docker image (packaging/desktop/).
- No uinput and no VNC.

### 1.12 Service install

| | daemon | computer |
|---|---|---|
| kind | systemd user unit `~/.config/systemd/user/agentum.service` | systemd system unit, copied by hand |
| contents | `ExecStart="<bin>" run`, PATH with ~/.local/bin and ~/.bun/bin, `Restart=on-failure`, `RestartSec=5`, `RestartPreventExitStatus=3`, `WantedBy=default.target` | `User=hm`, `HM_STATE_DIR=/var/lib/hm-computer`, `EnvironmentFile=-/etc/hm-computer.env`, `Restart=always`, `StateDirectory`, `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`, `ProtectHome=read-only` |
| linger | checks `loginctl show-user -p Linger` and exits 2 when it is off. Never runs `enable-linger` itself (install-service.ts:329-337) | n/a |
| refuses root | yes (install-service.ts:277) | `run` refuses root unless `--allow-root` |
| legacy | removes `harbourmaster.service` | none |
| macOS | "launchd is not supported yet" | the binary runs on darwin, with no service |

### 1.13 Agent OS user (daemon only, agent-user.ts, agent-process.ts)

- `hm-agent` is created by `sudo useradd --system --create-home --home-dir /home/hm-agent --shell /bin/bash`.
- A sudoers drop-in `/etc/sudoers.d/agentum-<user>` is written, checked with `visudo -cf`, then installed with `install -m 0440 root:root`. The rule:
  `<user> ALL=(hm-agent) CWD=* NOPASSWD: SETENV: <claude>, NOSETENV: /bin/mkdir, /bin/rm, /usr/bin/dd, /usr/bin/head, /usr/bin/realpath, /usr/bin/stat, /usr/bin/find`
- Claude is spawned as `sudo -n -u hm-agent -H --preserve-env=<secret names> -D <workdir> <claude> <args>`, with the child's cwd at `/`.
- All work-dir file I/O in multi-user mode goes through `sudo -n -u hm-agent dd/head/stat/find/rm/mkdir` (work-files.ts, work-disk.ts).
- If any step fails, the machine falls back to `singleUser` (claude runs as the daemon user) and the install carries on.

### 1.14 Logging, update, version

- Logging:
  - Daemon: `[agentum] msg` lines, stdout for info and stderr for errors. No levels.
  - Computer: slog on stderr, JSON for `run` and text for `enroll`, fixed Info level.
- Version:
  - Daemon: `<package version>+<short sha>` through a define, else `0.1.0`.
  - Computer: `-X main.version`, which release builds set to the same string, `0.0.0-dev` locally and `0.0.0-docker` in images (inferred).
- Update: neither client updates itself. The daemon updates by re-running `install.sh`, which runs `install-service --refresh`. The computer updates by re-running the installer and restarting by hand.

### 1.15 Things only one client does, or that the two do differently

- Only the daemon: runs, approvals, library sync, skills, input files, MCP handover, masking, service install, hm-agent, linger check, feature negotiation.
- Only the computer:
  - exec, file ops and desktop
  - audit log
  - local policy flags
  - orphan sweep
  - plaintext and redirect refusal
  - `--code-stdin`
  - `status --json`
  - darwin builds
  - Docker images
- Done differently by both: enrol body, CLI spelling, state dir, credential file layout, heartbeat style and interval, backoff formula and reset window, the replaced close code (1012 vs 4409), log format, the meaning of exit 2, unit kind (user vs system) and restart policy.

---

## 2. Wire contracts

Full table with server file:line: server.md section 1.

| # | Endpoint | Used by | Auth | Schema | Fixtures |
|---|---|---|---|---|---|
| 1 | `POST /api/machines/enroll` | both | code in body | `machineEnrollRequestSchema`, `enrollResponseSchema` (packages/protocol/src/machine.ts:62-93) | `packages/protocol/fixtures/enroll-*.json`, `apps/computer/testdata/enroll/` |
| 2 | WS `GET /api/machines/connect` | agent_host | machine credential | `daemonFrameSchema`, `relayFrameSchema` (machine.ts:95-156) | `packages/protocol/fixtures/{hello,ping,hello-ack,offer,cancel,library-changed}.json` |
| 3 | WS `GET /api/machines/computer` | computer | computer credential | packages/protocol/src/computer.ts (frozen, `protocol_version:1`) | `apps/computer/testdata/protocol/*.json` (24 files, read by Go tests and by packages/protocol/src/computer.test.ts:13) |
| 4-10 | `POST /api/machines/runs/:id/{claim,events,heartbeat,complete,needs-approval,requests}`, `GET .../requests/:rid?wait=` | agent_host | machine credential | machine.ts:158-295 (strict zod) | `packages/protocol/fixtures/{claim-response,events-*,heartbeat-response,complete-*}.json`, `apps/daemon/fixtures/tool-run/{sdk-messages,events,complete}.json` |
| 11-12 | `GET /files/:id`, `POST /api/files` | agent_host run | run token | inline | none |
| 13 | `GET /api/runs/:id/skills[/file?path=]` | agent_host run | run token | protocol/src/skills.ts | none |
| 14 | `/api/runs/:id/library/*` | agent_host run | run token | protocol/src/library.ts | none |
| 15 | `/mcp` | the claude CLI (from claim `mcpServers`, type `http`) | run token in headers | MCP | n/a |
| - | `GET /install.sh`, `/install-computer.sh`, `/releases/<product>/latest.json`, `/releases/<product>/<ver>/<file>` | installers | none | releases/manifest.ts | none |

Both sockets end in one `MachineRelay` Durable Object per machine, tagged `daemon`, `computer` or `viewer` (apps/web/src/server/relay.ts). A bad credential gets an accepted upgrade that closes at once with 4401, never an HTTP 401.

Schemas exist only as zod, plus the JSON fixtures. A Rust client needs serde types tested against both fixture folders. `apps/daemon/fixtures/tool-run/sdk-messages.json` is a golden stream-json sample for the claude output parser. Several claim keys are gated: the strict claim schema means the server adds `env`, `library.roots`, `taskFolder`, `toolRules` and `currentApprovals` only when `X-Daemon-Features` names the feature.

### One machine, both roles

- Can a row hold both roles today? Yes. There is no role column. `agent_host` is derived from `credential_hash` not starting `computer-only:`, and `computer` from `computer_status` being set (services/src/machines.ts:131-137). The UI shows one line per role.
- What it takes today: two enrolments in a fixed order. First an `agent_host` code makes the row. Then an "Add computer role" code is minted for that machineId (machines.ts:242-247). That gives two different `hm_mach_` tokens in two tables. The reverse order, adding agent_host to a computer-only row, is refused.
- `authenticate(role)` opens one role per credential (machines.ts:424-445). A computer credential cannot reach the run routes or `/mcp`.

Options for the single client:
- A, no server change. Enrol twice and store two credentials. This needs two codes, the second minted only after the first enrolment. It is poor UX for "install once".
- B, recommended. One code, one enrolment, one credential for both roles. Server changes (server.md section 2):
  1. A new enrol body, e.g. `roles:["agent_host","computer"]`, carrying the computer fields and `singleUser`, with a matching code kind. It needs no migration, because the `role` columns are plain text.
  2. `enroll` writes the same hash into `machines.credential_hash` and into a `machine_credentials` row with role computer, plus `computer_status="offline"`, in one `atomic` write. `authenticate` then opens both roles unchanged. Check machines.test.ts for an assertion that the two hashes differ.
  3. `createEnrollToken` and the enrol dialog get a "both" choice.
  4. Routes, the relay DO and the listing need no change. The client still opens two sockets with two protocols.
  5. Return the machine name in the enroll response so the unit name can include it (see below). `enrollResponseSchema` is strict in today's daemon, so add the field only for the new body kind. Old daemons would reject an unknown key. Do not add it to `hello_ack`. `relayFrameSchema` is a union of strict objects (machine.ts:124-156), so a deployed daemon would drop the ack as unparsable (client.ts:231), hit the 40 s ack timeout and reconnect forever. A new relay frame type would be safe, because old daemons just log it and drop it.
- Machine name for the unit. `machines.name` is set from the code's `machine_name` when the code is minted (schema/machines.ts:43, 61). The client never receives it today, and there is no rename. Without server change 5, the CLI would need a `--name` flag that repeats what the user typed in the dialog.

---

## 3. The Claude Agent SDK question

### 3.1 What the daemon uses (executor.ts:331-384, approvals.ts:367-375, agent-process.ts)

The only call is `query({prompt: AsyncIterable<SDKUserMessage>, options})` (run.ts:6, executor.ts:416). Options, and what the SDK 0.2.119 turns each into (read from `sdk.mjs` in `node_modules/.bun/@anthropic-ai+claude-agent-sdk@0.2.119+…`):

| option | value in the daemon | what SDK sends to `claude` |
|---|---|---|
| (always) | | argv `--output-format stream-json --verbose --input-format stream-json` |
| `pathToClaudeCodeExecutable` | config.claudeBinary (system claude, 2.1.318 here) | the command (SDK bundled native binary NOT used) |
| `spawnClaudeCodeProcess` | wraps in `sudo -n -u hm-agent -H --preserve-env=… -D <cwd>` | SDK hands `{command,args,cwd,env,signal}` to the callback |
| `cwd` | work dir | spawn cwd (daemon swaps to `/` + `sudo -D`) |
| `env` | filtered env + agent secrets | spawn env. SDK adds `CLAUDE_CODE_ENTRYPOINT=sdk-ts` if absent, deletes `NODE_OPTIONS` |
| `model` | claim.agent.model | `--model` |
| `maxTurns` | from runtimeConfig | `--max-turns` |
| `maxBudgetUsd` | optional | `--max-budget-usd` |
| `resume` | session id when this machine holds it | `--resume <id>` |
| `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions` | | `--permission-mode bypassPermissions --allow-dangerously-skip-permissions` |
| `settingSources: ["project"]` | | `--setting-sources=project` |
| `strictMcpConfig: true` | no `mcpServers` option | `--strict-mcp-config` |
| `thinking: {type:"adaptive", display:"summarized"}` | | `--thinking adaptive --thinking-display summarized` |
| `canUseTool` (always-allow) | | `--permission-prompt-tool stdio`, then answers `can_use_tool` control requests |
| `hooks.PreToolUse` (timeout 90000 s) | | in the `initialize` control request: `hooks:{PreToolUse:[{matcher:undefined, hookCallbackIds:["hook_0"], timeout}]}`, answers `hook_callback` requests by returning the HookJSONOutput verbatim as `control_response.response` |
| `systemPrompt: {type:"preset", preset:"claude_code", append}` | instructions + workspace text | `appendSystemPrompt` in `initialize` only (no flag, no `systemPrompt` field) |
| `abortController` | run abort | SIGTERM to the child |
| `q.setMcpServers(claim.mcpServers)` | http servers with run-token headers | control request `{subtype:"mcp_set_servers", servers:{name:{type:"http",url,headers}}}`, so the token is never on argv |
| `q.close()` | | ends the process |

Not used: `tool()`/`createSdkMcpServer` (no in-process MCP), `interrupt()`, `includePartialMessages`, `setPermissionMode`, `setModel`, elicitation, OAuth, structured output, subagents. The daemon reads only `system/init` (session_id), `assistant` blocks (text, thinking, tool_use), `user` tool_result blocks and `result` (subtype, result, errors, usage, total_cost_usd) (normalize.ts).

### 3.2 Wire sequence a Rust client would have to reproduce

1. Spawn `claude` with the argv above. The env depends on the mode:
   - Single-user: the child gets the filtered env plus secrets, and `CLAUDE_CODE_ENTRYPOINT=sdk-ts`. agent-env.ts strips the parent's copy, and the SDK adds it back.
   - Multi-user: `sudo -n -u hm-agent -H --preserve-env=<secret names>` resets the env. Only the secret names and sudo's defaults (secure_path, HOME, USER, LOGNAME) reach claude, so today the allow list and `CLAUDE_CODE_ENTRYPOINT` never arrive.
   - Whether the CLI behaves differently without `CLAUDE_CODE_ENTRYPOINT` is unverified. A Rust client that spawns through sudo must choose explicitly what to preserve.
2. Write `{"type":"control_request","request_id":"<id>","request":{"subtype":"initialize","hooks":{…},"appendSystemPrompt":"…"}}`, wait for `{"type":"control_response","response":{"subtype":"success","request_id":…}}`.
3. Write the `mcp_set_servers` control request and wait for its response. The daemon gates the first message on this.
4. Write one line: `{"type":"user","message":{"role":"user","content":"<text>"},"parent_tool_use_id":null}` (exactly executor.ts:170; SDK `streamInput` writes the object as is).
5. Read stdout lines: SDK messages (`system`, `assistant`, `user`, `result`, …), plus `control_request` from the CLI with subtype `can_use_tool` (reply `{behavior:"allow", updatedInput, toolUseID}`) or `hook_callback` (`callback_id`, `input`, `tool_use_id`; reply with the hook output), plus `control_cancel_request` (abort that pending callback).
6. After the `result` message, close stdin (the SDK closes it only after the first result when hooks or canUseTool exist). The CLI exits by itself.

### 3.3 Can Rust do this directly, and how stable is it

- `--input-format stream-json` and `--output-format stream-json` are documented CLI flags (headless mode docs). The message shapes are the SDK's public `SDKMessage` types.
- The control protocol (`control_request`, `initialize`, `can_use_tool`, `hook_callback`, `mcp_set_servers`) is not documented as a public contract. It is the private channel between the SDKs and the CLI. The open-source Python Agent SDK (anthropics/claude-agent-sdk-python) implements the same protocol in readable source and is the best reference (from memory, not found on this machine). Community Rust crates exist that speak it (from memory, unverified).
- Today the daemon already lives with version skew. SDK 0.2.119 drives whatever system `claude` is installed (2.1.318 on this box) through `pathToClaudeCodeExecutable`. So the daemon already depends on the CLI keeping this protocol stable across versions. A Rust client takes the same bet, without the SDK release that would track a change.
- Each piece used is a small surface: two control requests out, two control requests in plus cancel, five message types read. In-process MCP would have been the hard part (`mcp_message` tunnelling JSON-RPC), and it is not used.

### 3.4 Recommendation: (a) Rust speaks the CLI protocol directly, with guard rails

Reasons:
- (b), a bun-compiled TS runner, ships the bun runtime again. Today's binary is 95 MB (`apps/daemon/dist/agentum-linux-*`), almost all of it bun plus the SDK. A runner would either keep that size inside the Rust binary or be a second downloaded artifact with its own version, update and checksum path. It also keeps two languages in the client for good.
- The surface used is small and fully visible (3.1, 3.2). It needs no in-process MCP and no SDK-only helpers.
- The skew risk already exists with the SDK, because the daemon uses the system claude and not the SDK's bundled binary.

Guard rails to plan in:
1. Pin a minimum `claude --version` at startup and at enrol, and explain in the CLI when it is too old.
2. Add a conformance test that runs the real `claude` (as the V1.12 spike did, approvals.ts:3-15) through initialize, mcp_set_servers, a hook deny and allow, an AskUserQuestion `updatedInput`, `--resume`, an abort, and turn-limit and budget results. Run it in CI against the pinned and latest CLI.
3. Use `fixtures/tool-run/sdk-messages.json` as the parser golden file. Tolerate unknown message types and fields, and log them.
4. Keep (b) as the fallback if Anthropic changes the control protocol in a way that breaks it. Build the run executor behind a trait so a runner process could replace it.

Also port these pieces of shared TS logic, or have the server send them precomputed:
- `workspaceInstructions` (protocol/src/attachments.ts, 210 lines, the prompt text about library and scratch dirs). Better produced on the server and sent in the claim.
- `maxTurnsOf` and `stopMessage` (safeguards.ts).
- `toolKey`, `approvalSummary`, `outcomeText` and `askUserQuestionAnswers` (requests.ts).
- `taskFolderPath` (@repo/db/shared).
- `createMasker` (masker.ts).
- `@repo/library-sync` (about 600 lines, conflict and etag semantics; it also has 13+12 KB of tests to mirror).

---

## 4. Conflicts with user-level service mode, and privilege points

### 4.1 Every place a privilege is checked or needed today

| where | what | needs |
|---|---|---|
| daemon install-service.ts:277 | refuses uid 0 | non-root |
| install-service.ts:165-176 | `sudo useradd --system … hm-agent` | root through sudo, may prompt (stdin inherited, command.ts:24) |
| install-service.ts:115-151 | `sudo visudo -cf`, `sudo install -m 0440 -o root` into /etc/sudoers.d, `sudo rm -f` legacy | root through sudo |
| agent-user.ts:96-110 | `sudo -k -n -u hm-agent <claude> --version` | the sudoers rule, and claude must be executable by hm-agent (not in a private home) |
| agent-process.ts | every claude spawn through `sudo -n -u hm-agent` | the sudoers rule |
| workdir.ts, work-files.ts, work-disk.ts | mkdir, rm, dd, head, stat, find, realpath as hm-agent through `sudo -n` | the sudoers rule. A missing `find` gives "sudo refused find as hm-agent: run agentum install-service again to allow it" (work-disk.ts:210) |
| install-service.ts:297-337 | `systemctl --user …`, `loginctl show-user -p Linger` | a user systemd instance (needs `XDG_RUNTIME_DIR`/a login session, inferred). Linger is not enabled automatically |
| computer state.go:187-192 | refuses root without `--allow-root` | non-root |
| computer state.go:82-85 | state dir owned by the current uid | ownership |
| computer system unit | `User=hm`, written to /etc/systemd/system by hand | root to install |
| desktop | Xvfb, openbox, xdotool, xclip, chromium on PATH. `/tmp/.X11-unix` writable. `/tmp/.X<N>-lock` free. Chromium needs unprivileged user namespaces (or the seccomp profile and `CAP_SYS_CHROOT` in Docker) | packages installed (root once), no runtime root. No uinput, no input/video group |

### 4.2 Conflicts with a user-level service

- The separate agent user is the main conflict. hm-agent plus sudoers needs root once at install, and through sudo on every run. In user mode without sudo, the client must fall back to single-user, which is today's `singleUser: true`, and say so plainly.
- It also breaks multi-instance. One `hm-agent` and one `/home/hm-agent/agentum/<ws>/<agent>` tree are shared by every instance. The plan should key agent users or work roots by instance, e.g. `hm-agent-<instance>`, or a per-instance root.
- System mode with a separate agent user needs no sudo at all if the service runs as root, or with `CAP_SETUID` and spawns claude as the agent user directly. But both clients refuse root today. Decide which way to go:
  1. Service user `agentum-<name>` plus agent user, with a narrow sudoers rule, as today.
  2. A root supervisor that drops privileges per run (simpler file I/O, more risk).
- `systemctl --user` from the service or from a non-login shell (sudo, ssh without a session) fails without `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` (inferred). `loginctl enable-linger <self>` works without root on most distros through polkit, but can be denied (inferred). The CLI should try it and print the exact command on failure.
- Desktop in user mode: it needs no root at runtime. The problems are package installation (root once) and display number collisions between instances, so allocate `--desktop-display` per instance. With the computer unit's `PrivateTmp=true`, X sockets are private to the unit (inferred), which actually helps isolation. A systemd user unit cannot use `ProtectSystem` or `User=` hardening the same way (inferred).
- systemd system units need root, and the CLI must not try to install one without it.

### 4.3 What the CLI should say (current wording to keep or improve)

- Root refused: "run install-service as the user that will run the daemon, not as root: it calls sudo itself for the steps that need root" (install-service.ts:278-280), and "refusing to run as root: create an unprivileged user for this computer, or pass --allow-root if you accept the risk" (state.go).
- Linger: "lingering is off for <user> … Enable it with: loginctl enable-linger <user>" → exit 2.
- claude not reachable by the agent user: "<user> could not run <claude> as hm-agent. The binary must be executable by hm-agent, so it cannot sit in a private home directory. Install it system-wide, then run install-service again with --claude <path>" (install-service.ts:192).
- visudo rejected the rule, useradd failed, sudo refused `find`: as quoted in daemon.md.
- State dir owned by someone else: the state.go:82-85 message.
- Desktop: "<bin> is not installed; see install.sh --desktop …". This is stale, because there is no such flag. Replace it with the package list for the distro.
- Missing everywhere today, and worth adding:
  - a `doctor` that checks claude on PATH and its version
  - sudo -n for each helper
  - linger, user bus reachable, unit installed and active
  - desktop binaries, user namespaces (`/proc/sys/kernel/unprivileged_userns_clone`, AppArmor `apparmor_restrict_unprivileged_userns` on Ubuntu 24.04+, inferred)
  - state dir mode and owner
  - server reachable, credential accepted

  Each failure should print the one command that fixes it.

---

## 5. Release and install today

- Build:
  - Daemon: `bun build --compile --minify --target=bun-linux-{x64,arm64} … --define process.env.HM_DAEMON_VERSION=<v>`, run from `apps/web/scripts/publish-releases.ts:133-154`. Output is `agentum-linux-x64` and `agentum-linux-arm64`, about 95 MB each.
  - Computer: `apps/computer/scripts/build-all.sh`, `CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=…"`, for linux and darwin on amd64 and arm64, named `hm-computer_<goos>_<goarch>`.
  - The version string is the same for both: `<apps/daemon/package.json version>+<short sha>` (releases/manifest.ts:24-39).
- Publish: by hand, `bun scripts/publish-releases.ts --env staging|production` from apps/web.
  - It runs `wrangler r2 object put` into R2 buckets `agentum-v2-files` and `agentum-v2-staging-files`.
  - Keys are `releases/<product>/<version>/<file>`, with `releases/<product>/latest.json` uploaded last.
  - It refuses a dirty tree and skips a version that is already published.
  - Integrity is a sha256 per file in `latest.json`, with no signing.
  - `latest.json` is written one key per line because the install scripts parse it with sed and awk. That format is a contract.
  - No GitHub workflow publishes binaries.
- Serve: `apps/web/src/server/routes/releases.ts`.
  - `/install.sh` and `/install-computer.sh` are templated with the request origin.
  - `/releases/<product>/latest.json`.
  - `/releases/<product>/<version>/<file>`, immutable, served only for names in `PRODUCT_FILES` (manifest.ts:14-22).
- Machines page commands (apps/web/src/components/machines/enroll-commands.ts, enroll-dialog.tsx:172-195):
  - agent_host: `curl -fsSL <origin>/install.sh | sh -s -- --code <code>`. Installs `~/.local/bin/agentum`, runs `install-service`, then `enroll <code> --server <origin>`. A re-run on an enrolled machine runs `install-service --refresh`.
  - computer, binary: `curl -fsSL <origin>/install-computer.sh | sh -s -- --code <code>`. Installs `~/.local/bin/hm-computer`, runs `enroll --url --code`, then tells the user to run `hm-computer run`. No service.
  - computer, Docker headless: `docker run -d --restart unless-stopped --name hm-computer -v hm-computer:/var/lib/hm-computer ghcr.io/codewithpassion/agentum-computer:latest --url <origin> --code <code>`.
  - computer, Docker desktop: the same image name with `-desktop`, plus `--shm-size=256m --cap-drop ALL --cap-add SYS_CHROOT --security-opt no-new-privileges --security-opt seccomp=packaging/desktop/seccomp.json`. The user has to run it from inside apps/computer for the seccomp file.
  - The update hint on a machine row is `curl -fsSL <origin>/install.sh | sh` (machine-row.tsx:82-95).
- Docker:
  - `apps/computer/Dockerfile`: busybox, uid 1000, entrypoint `hm-computer run`, no init.
  - `apps/computer/Dockerfile.desktop`: Debian bookworm-slim, Xvfb, openbox, chromium, xdotool, xclip, tini.
  - Both are pushed to ghcr by `.github/workflows/computer.yml` on `workflow_dispatch`, tagged `latest` and the sha. The workflow sets no version, so images likely report `0.0.0-docker`, and no `platforms`, so they are likely amd64 only (both inferred).
  - There is no daemon image.
- Contracts a replacement must keep or migrate in the same deploy:
  - the binary names in `PRODUCT_FILES`
  - both CLI spellings (`enroll <code> --server`, `enroll --url --code`, `--version`, `version`)
  - `~/.agentum/config.json` and `~/.hm/config.json`, which the scripts check for "already enrolled"
  - `/var/lib/hm-computer` and the image names
  - the exact version string the update hint compares
  - the `latest.json` line format

---

## Open questions for Dom

1. Should the binary be small? If yes, option (b) in section 3 is out.
2. One credential for both roles (server option B), or two enrolments?
3. Should the machine name come from the server (a new enroll response field), or from a `--name` flag?
4. Should the agent OS user stay in user-service mode (it needs sudo), and should it be per instance?
5. Is macOS in scope? The computer ships darwin today, and the daemon does not.
