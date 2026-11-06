# apps/daemon inventory (read at e29151e7, worktree deploy-ep)

Paths relative to apps/daemon/src unless noted.

## CLI (main.ts)
- `agentum enroll <code> --server <url> [--claude <path>]`
- `agentum run` (foreground daemon)
- `agentum status`
- `agentum install-service [--claude <path>] [--refresh]`
- `-h/--help`, `-v/--version`. parseArgs strict: unknown flag = exit 1.
- No `--config` flag; config path is only injectable in tests (MainDeps.configPath).
- Env read: `HM_DAEMON_VERSION` (build-time define, version.ts:20), `USER` fallback (install-service.ts:99), process.env passed filtered to claude (agent-env.ts). `DEBUG_CLAUDE_AGENT_SDK` read by the SDK itself.

## Exit codes (exit-codes.ts)
0 ok, 1 failure, 2 linger missing (install-service only), 3 credential rejected (relay close 4401). Unit has RestartPreventExitStatus=3.

## State
- Config `~/.agentum/config.json` (legacy `~/.harbourmaster/config.json` if only that exists), dir 0700, file 0600, atomic tmp+rename (config.ts). Fields: claudeBinary|null, credential (hm_mach_/ag_ prefix via MACHINE_CREDENTIAL.matches), machineId, server (origin), singleUser.
- Work dirs: single-user `~/agentum/<ws>/<agent>/work` (legacy `~/harbourmaster/` if exists); multi-user `/home/hm-agent/agentum/<ws>/<agent>/work` (workdir.ts). Per run wipes `.claude/`, `.mcp.json`, `inbox/`, `tmp/`; keeps `library/` and `library.manifest.json`.
- Skills into `.claude/skills/` (skills-sync.ts:11). Input files into `inbox/` (run-files.ts).

## Enrol (enroll.ts)
POST `<server>/api/machines/enroll` `{code, singleUser}`; response `{credential, machineId}`. singleUser = no claude found OR `sudo -k -n -u hm-agent <claude> --version` fails. Prints next step (`systemctl --user restart agentum` if unit exists, else `agentum run`).

## Relay connection (client.ts)
- WS `<server with ws/wss>/api/machines/connect`, `Authorization: Bearer <credential>`.
- On open: hello `{type:"hello", agents:[], capabilities:{agentSdk:"claude-agent-sdk@0.2.119", container:false}, daemonVersion, features:[library-sync, requests, library-live, current-approvals]}`.
- Ping `{type:"ping", at}` every HEARTBEAT_SECONDS=20s; no pong expected. hello_ack timeout 40s -> drop socket.
- Backoff: 1s * 2^n capped 60s, jitter x[0.8,1.2], clamped (backoff.ts). Attempt counter resets only after 30s stable after hello_ack (STABLE_MS).
- Close 4401 -> exit 3. Close 1012 (replaced) -> abort all runs, reconnect.
- Relay frames: hello_ack, offer{agentId,runId}, cancel{runId}, library_changed{paths}.

## Runs (run-manager.ts, executor.ts, run-api.ts)
- One run per agent at a time, queue per agent, different agents parallel. Repeated offers ignored.
- HTTP under `/api/machines/runs/<runId>/` with machine credential bearer: `claim` (POST, header X-Daemon-Features), `events` (POST {events:[{seq,type,payload}]}), `heartbeat` (POST, every 20s; 409 aborts), `complete` (POST; 409 on aborted is OK), `requests` (POST), `requests/<id>?wait=25` (GET long poll), `needs-approval` (POST {toolKey}). 30s timeout per call.
- Run token (`run_token` prefix) routes: `/api/runs/<runId>/skills`, `/skills/file?path=`; `/api/runs/<runId>/library/{file,list,stat,conflicts}` with GET/PUT/DELETE and etag headers; files download `GET <server>/files/<id>` and upload `POST <server>/api/files` multipart (files-api.ts). 120s timeouts.
- Event batcher 500ms, max 100 per batch, seq from 1, drop on permanent 4xx except 408/429 (event-batcher.ts).
- Masking of credential, run token and agent secrets in every body/log (`@repo/protocol/masker`).
- Kill: SIGTERM then SIGKILL after 5s (executor.ts:139). Stderr tail 500 chars goes into the failure message.
- Completion: done/failed (turn_limit stop)/aborted; runtimeRef = session id; usage costUsd/input/output tokens.
- Signals SIGINT/SIGTERM: abort all runs, post `aborted`, exit 0.

## Approvals (approvals.ts)
PreToolUse hook (timeout 25h) decides; canUseTool always allows and exists only so AskUserQuestion is offered. Rules from claim.toolRules or live `needs-approval` (currentApprovals). Retries transient (0/408/429/5xx) 10x with backoff then deny. Fails closed. "always_allow" drops key for rest of run.

## Library sync (library-sync.ts + packages/library-sync)
syncIn before first message; watcher (single-user only, fs.watch per folder) pushes edits after quiet time; checkpoint every 5 min; final syncOut after exit, before complete; `library_changed` pulls. Multi-user goes through sudo find/stat/dd/head/rm (work-disk.ts). 10MB file cap. Conflicts saved as `<path>.conflict-<runId>`.

## Service install (install-service.ts)
- Refuses root. Linux only (darwin: "launchd is not supported yet").
- Writes `~/.config/systemd/user/agentum.service` (ExecStart="<binary>" run, PATH env with ~/.local/bin, ~/.bun/bin; Restart=on-failure, RestartSec=5, RestartPreventExitStatus=3, WantedBy=default.target). Retires legacy `harbourmaster.service`.
- Unless --refresh: creates `hm-agent` via `sudo useradd --system --create-home --home-dir /home/hm-agent --shell /bin/bash`, writes sudoers drop-in `/etc/sudoers.d/agentum-<user>` (visudo -cf check, install -m 0440 root:root), removes legacy `/etc/sudoers.d/harbourmaster-<user>`; verifies with `sudo -k -n -u hm-agent <claude> --version`.
- sudoers line: `<user> ALL=(hm-agent) CWD=* NOPASSWD: SETENV: <claude>, NOSETENV: /bin/mkdir, /bin/rm, /usr/bin/dd, /usr/bin/head, /usr/bin/realpath, /usr/bin/stat, /usr/bin/find`.
- systemctl --user daemon-reload, enable, restart (only if config exists). Checks `loginctl show-user <user> -p Linger`; exit 2 when off, message says `loginctl enable-linger <user>`. Does NOT enable linger itself.
- Fixed service name `agentum`: one instance per user today.

## Status (status.ts)
Prints machine, server, single_user, claude, config path, service state (`systemctl --user cat/is-active agentum`).

## Logging (log.ts)
`[agentum] <msg>` lines, info to stdout, errors stderr; journald reads it. No levels, no JSON.

## Version (version.ts)
`HM_DAEMON_VERSION` define `<pkg>+<sha>` else package.json version 0.1.0. No self-update; update = download new binary + `install-service --refresh`.

## Build
`bun build --compile --minify --target=bun-linux-{x64,arm64}` -> dist/agentum-linux-* (~95 MB each). Linux only.
