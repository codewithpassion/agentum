# hm-computer (apps/computer) feature-parity inventory

Source: `/home/roboto/devel/harbourmaster-wt/deploy-ep/apps/computer`, read on 2026-11-05. All paths below are relative to `apps/computer/` unless they start with `apps/` or `packages/`. "Inferred" marks anything not read directly in code (mostly Go stdlib behaviour). Go module `agentum.dev/computer`, go 1.23, deps: `github.com/coder/websocket v1.8.15`, `github.com/jezek/xgb v1.3.1` (pure-Go X11 client), `golang.org/x/sys v0.30.0` (go.mod:5-9). Static build, `CGO_ENABLED=0`.

Non-test source is about 4,100 lines across: `cmd/hm-computer/{main,enroll,serve,status}.go`, `internal/{agent,audit,conn,desktop,enroll,files,policy,protocol,runner,serverurl,state}`.

Two consumers of contracts outside this folder:
- `packages/protocol/src/computer.test.ts:13` reads `apps/computer/testdata/protocol/` too, so the fixtures are the shared server/client contract.
- `apps/web/src/server/releases/install-computer.sh` downloads `hm-computer_<os>_<arch>` and calls `hm-computer version` and `hm-computer enroll --url <origin> --code <code>`. It checks `$HOME/.hm/config.json` to decide "already enrolled". A Rust port must keep the binary name, these two subcommands, the default state dir `~/.hm` and the `config.json` file name.
- `apps/web/src/components/machines/enroll-commands.ts` prints the docker one-liners (image names `agentum-computer`, `agentum-computer-desktop`, volume path `/var/lib/hm-computer`, `--url` and `--code` passed after the image).

---

## 1. CLI

Dispatcher: `cmd/hm-computer/main.go:31-55`. Hand-rolled first-arg switch, then Go `flag` package per subcommand with `flag.ContinueOnError`. Go flags accept both `-flag` and `--flag`, and `-flag=value` or `-flag value` (verified: `status -json` works with the local build). A Rust port with clap must accept single-dash long flags too if any existing unit/env/docs use them (docs all use `--`).

### Top level
| arg | behaviour | exit |
|---|---|---|
| (none) | usage to stderr | 2 (main.go:32-35) |
| `enroll` | runEnroll | see below |
| `run` | runServe | see below |
| `status` | runStatus | see below |
| `version`, `--version`, `-v` | prints `version` to stdout | 0 (main.go:44-46) |
| `help`, `--help`, `-h` | usage to stdout | 0 (main.go:47-49) |
| anything else | `unknown command "<x>"` + blank line + usage to stderr | 2 (main.go:50-53) |

Usage text verbatim (main.go:58-72):
```
hm-computer — connect a machine you own to Agentum

Usage:
  hm-computer enroll --url <base> --code <code> [--name <name>] [--state-dir <dir>] [--desktop]
  hm-computer run [--url <base>] [--code <code>] [flags]
  hm-computer status [--state-dir <dir>]
  hm-computer version

Environment:
  HM_URL           default for --url
  HM_ENROLL_CODE   default for --code
  HM_STATE_DIR     default for --state-dir

Run "hm-computer <command> --help" for the flags of one command.
```
`hm-computer <cmd> --help`: Go's flag package prints the flag defaults to stderr and Parse returns ErrHelp, which the code maps to exit 2 (enroll.go:64-66, serve.go:63-65, status.go:39-41). So subcommand help exits 2, not 0 (verified: `bin/hm-computer_linux_amd64 run --help` exits 2 and prints `Usage of run:` then the flag list). Any unknown flag or bad value also exits 2.

### `enroll` (cmd/hm-computer/enroll.go)
Flags (enroll.go:30-40):
| flag | default | meaning |
|---|---|---|
| `--url` | `$HM_URL` | base URL of the server |
| `--code` | `$HM_ENROLL_CODE` | single-use code; help text says prefer env or `--code-stdin` because argv shows in ps |
| `--code-stdin` | false | read code from stdin: first line, trimmed; EOF without newline is fine (enroll.go:44-59) |
| `--name` | "" | hostname override |
| `--state-dir` | `state.DefaultDir()` | state directory |
| `--log-format` | `text` | `json` or `text` (anything not `text` is JSON, main.go:81-86) |
| `--desktop` | false | persist `"desktop": true` into config.json for every later run |

No positional args (extra positional args are silently ignored, inferred: code never reads `set.Args()`).

Flow and exits:
- `--code-stdin` with empty stdin: prints `--code-stdin was given but standard input carried no code`, exit 2 (enroll.go:55, 69-72).
- missing url or code: `both --url and --code are required (or HM_URL and HM_ENROLL_CODE)`, exit 2 (enroll.go:73-76).
- code refused (HTTP 401): `The enrollment code was refused. Codes are single use; issue a new Agentum enrollment code.` exit 1 (enroll.go:84-86).
- insecure URL or redirect: prints error, exit 2 (enroll.go:87-89).
- other failure: logged `enrollment failed` with `error`, exit 1 (enroll.go:90-91).
- success: logs `enrolled` (machineId, state_dir, credential path), prints to stdout `Enrolled as <machineId>. Start the daemon with:\n  hm-computer run\n`, exit 0 (enroll.go:95-100).
- `enroll` does NOT check for root and does NOT refuse an existing credential: it overwrites credential and config (inferred from code: no existence check).
- After the HTTP call, success or failure, the code is cleared from the flag struct and `HM_ENROLL_CODE` is unset from the process env (enroll.go:116-118, 138-141).

### `run` (cmd/hm-computer/serve.go)
Flags (serve.go:39-61):
| flag | default | meaning |
|---|---|---|
| `--url` | `$HM_URL` | overrides stored URL for this run only (not persisted) |
| `--code` | `$HM_ENROLL_CODE` | enrol if no credential yet |
| `--code-stdin` | false | as enroll |
| `--name` | "" | hostname override |
| `--state-dir` | DefaultDir() | state dir (credential, config, audit log) |
| `--workdir` | "" -> `<state-dir>/sessions` | root of per-session dirs, default cwd for commands |
| `--allow-root` | false | permit uid 0 |
| `--read-only` | false | refuse exec and every write |
| `--workdir-only` | false | confine file ops to workdir |
| `--max-concurrent` | 4 | commands running at once |
| `--max-queue` | 32 | commands waiting for a slot |
| `--max-exec-seconds` | 1800 | cap on a request's timeout |
| `--max-file-bytes` | 268435456 (256 MiB) | cap per file, both directions |
| `--log-format` | `json` | json or text |
| `--audit-max-bytes` | 8388608 (8 MiB) | rotate audit log at this size |
| `--audit-keep` | 3 | rotated audit files kept (0 means default 3, negative means keep none, audit.go:79-84) |
| `--desktop` | false | run the virtual desktop (also enabled by `"desktop": true` in config.json) |
| `--desktop-display` | 99 | X display number |
| `--allow` | repeatable | regex a command must match in full; empty list allows all |
| `--deny` | repeatable | regex a command must not match; checked first |
| `--allow-env` | repeatable | env var name the server may set on a restricted computer; trailing `*` = prefix |
Repeatable flags reject an empty/whitespace value: `an empty value is not useful here; remove the flag instead` (serve.go:30-36), exit 2.

Hidden constants that are NOT flags (a port should keep them): runner default timeout 30 s when `timeout_ms <= 0` (runner.go:100-102), runner WaitDelay 2 s (runner.go:106-108), conn max in-flight handlers 64 (conn.go:40), upload window 32, upload wait 60 s, max open uploads 8 (files.go:37-45).

Startup order (serve.go:63-220), which matters for behaviour:
1. Parse flags; build logger.
2. `CheckRoot(uid, --allow-root)`; on root: logs `refusing to run as root: create an unprivileged user for this computer, or pass --allow-root if you accept the risk`, exit 2 (serve.go:68-71, state.go:187-192).
3. `state.Ensure(stateDir)` (create 0700, refuse foreign owner, chmod 0700). Fail -> `could not prepare the state directory`, exit 1.
4. SIGINT/SIGTERM context (main.go:77-79).
5. Resolve code from stdin if asked (exit 2 on empty).
6. `ensureEnrolled` (serve.go:237-275): if credential readable, ignore and scrub the code, load config (missing config tolerated), apply `--url` override (canonicalised), error if no URL: `no server URL is stored and none was given; pass --url` (exit 1 via `could not start`). If no credential and no code: logs `this computer is not enrolled; run `hm-computer enroll --url <base> --code <code>` first`, exit 2. If no credential and a code: performEnrollment with a 60 s context, then reload config. ErrInsecure -> exit 2; code rejected, redirect or any other enrollment error -> `could not start` exit 1 (redirect is exit 2 in `enroll` but exit 1 in `run`).
7. Create sessions dir 0700 (`policy.EnsureDirectory`). Fail -> exit 1.
8. Build policy (compiles regexes; bad regex, overlap with state dir, `--workdir-only` with no workdir -> `the local policy is not usable`, exit 1). Sessions path is replaced by the policy's symlink-resolved workdir (serve.go:121).
9. Open audit log. Fail -> exit 1.
10. Detect capabilities (runs `python3 -c "import pydantic"` once, up to 10 s).
11. If desktop enabled: `desktop.Launch` (start + check). Failure is a warning only (`the desktop is not available to agents`), recorded in hello's `desktop_unavailable_reason`. On success commands get `DISPLAY` and `XAUTHORITY`.
12. `runner.Sweep` kills process groups left by a previous run; warns `reaped commands left behind by a previous run` with count.
13. Build runner, transfers, agent, hello, conn client. ErrInsecure at conn build -> exit 2.
14. Log `starting` with machineId, url, version, run_as, state_dir, workdir, read_only, workdir_only, allow/deny/allow_env counts, max_exec_seconds, max_file_bytes, desktop, capabilities.
15. `client.Run(ctx)`. Revoked -> exit 3. Context cancelled or nil -> logs `stopped`, exit 0. Other -> exit 1 (not reachable in practice: Run only returns ctx errors or ErrRevoked).
16. Deferred on exit: `commands.Shutdown()` (cancel all + sweep), desktop Stop, audit close.

Persisting `--desktop` via `run`: only when `run` itself enrolls (serve.go:79, enroll.go:129). `run --desktop` on an already-enrolled machine does not write config.

### `status` (cmd/hm-computer/status.go)
Flags: `--state-dir` (DefaultDir), `--json` (false). Local only, no network, no root check.
JSON shape (status.go:18-33), keys mixed case, keep exactly:
```
{ "version", "state_dir", "enrolled", "url"(omitempty), "machineId"(omitempty), "hostname",
  "os", "arch", "run_as_user", "capabilities": {python3,git,skills,desktop,desktop_unavailable_reason},
  "audit_log", "pending_groups" }
```
`capabilities.desktop` is always false and reason null here, because status does not start a desktop (status.go:51). `hostname` is config `name` if set, else OS hostname. `pending_groups` = number of entries in `<state>/running/`.
Text output: fixed-width lines (status.go:82-105): `version`, `state dir`, `enrolled`, `machine id` (if set), `server` (if set), `hostname`, `platform os/arch`, `run as`, `python3`, `git`, `skills`, `audit log`, then `left behind   N command group(s) from a previous run; the next `run` reaps them` when >0, then `\nNot enrolled. Run: hm-computer enroll --url <base> --code <code>` when not enrolled.
Exit: config parse error -> `could not read the config: ...` exit 1; not enrolled -> 4; else 0.

### Environment variables read
| var | where | use |
|---|---|---|
| `HM_URL` | enroll.go:32, serve.go:40 | default for `--url` |
| `HM_ENROLL_CODE` | enroll.go:33, serve.go:41 | default for `--code`; unset after use (enroll.go:140) |
| `HM_STATE_DIR` | state.go:58 | default state dir |
| `USER` | state.go:200 | fallback for run_as_user when no passwd entry |
| `PATH`, `HOME`, `LANG` | runner.go:399-401 via `os.LookupEnv` (runner.go:419) | copied into command env if non-empty, else fallbacks |
| `HOME` | state.go:61 via `os.UserHomeDir()` | default state dir `~/.hm` |
| `HM_DESKTOP_EXPECT_SANDBOX` | tests only | |
Build scripts: `HM_COMPUTER_VERSION`, `HM_GO_IMAGE`, `HM_GO_CACHE_VOLUME`, `HM_GO_BUILD_CACHE_VOLUME`, `HM_DESKTOP_IMAGE`.

### Exit codes (main.go:19-25)
| code | name | when |
|---|---|---|
| 0 | exitOK | version, help, enroll success, status enrolled, run stopped by SIGINT/SIGTERM |
| 1 | exitFailure | enroll code refused or other enroll error; run: state dir, workdir, policy, audit, enrollment or URL-missing failures; status config unreadable |
| 2 | exitUsage | no args, unknown command, flag parse error (incl. subcommand `--help`, inferred), missing url/code, empty `--code-stdin`, insecure URL, enroll redirect, run as root without `--allow-root`, run not enrolled and no code |
| 3 | exitRevoked | run: server closed with 4401 |
| 4 | exitNotReady | status: not enrolled |

---

## 2. Enrol

Code: `internal/enroll/enroll.go`, `cmd/hm-computer/enroll.go:106-134`.
- Endpoint: `POST <base>/api/machines/enroll` (enroll.go:20). Unauthenticated. Headers `Content-Type: application/json`, `Accept: application/json`.
- URL built via `serverurl.HTTP` (ws->http, wss->https, path appended to any base path, query and fragment dropped).
- Client-side code check before sending: must start `ag_enr_` or `hm_enr_` and be at most 200 chars, else error `an enrollment code is required` (enroll.go:53-55, 150-152) -> exit 1 in `enroll`.
- Request body (enroll.go:27-34), `role` forced to `"computer"` (enroll.go:57). Fixture `testdata/enroll/request.json`:
  ```json
  {"arch":"arm64","clientVersion":"0.1.0","code":"hm_enr_test","hostname":"office-box","os":"linux","role":"computer"}
  ```
  `os` and `arch` are Go's `runtime.GOOS`/`GOARCH` strings (`linux`, `darwin`, `amd64`, `arm64`) (state.go:251-252). A Rust port must emit Go names, not Rust's `x86_64`/`aarch64`/`macos`. `hostname` = `--name` trimmed, else `os.Hostname()`, else `unknown` (state.go:239-248). `clientVersion` = build version.
- HTTP client: 30 s total timeout, refuses every redirect with `the enrollment endpoint redirected, which would resend the code elsewhere: <from> redirected to <to>` (enroll.go:113-123).
- Response body read capped at 1 MiB (enroll.go:44, 78).
- 401: `ErrCodeRejected` with the server's `{error}` text, summarised to 300 chars (enroll.go:82-88).
- Non-200: `enrollment failed: <endpoint> answered <status>: <error or body summary>` (enroll.go:89-92).
- 200: parse `{machineId, credential}` (fixture `testdata/enroll/response.json`: `{"credential":"hm_mach_test","machineId":"machine-1"}`). Rejects empty machineId or a credential not starting `ag_mach_`/`hm_mach_` (enroll.go:98-100).
- Stored on success (enroll.go:122-132): credential file, then config `{url: canonical(--url), machineId, name: hostname, desktop: --desktop}`. Note the credential is written before the URL is canonicalised, so an invalid URL here would leave a credential with no config (in practice URL was already validated by `serverurl.HTTP`).

### Server URL normalisation (internal/serverurl/serverurl.go)
- `Parse`: trim whitespace, strip one trailing `/`, require non-empty, scheme in `https|wss|http|ws`, host non-empty (serverurl.go:17-40).
- Plaintext (`http`/`ws`) allowed only when host is exactly `localhost` (case-insensitive) or a literal loopback IP (127.0.0.0/8, ::1, brackets stripped). `app.localhost` is refused (serverurl.go:100-109). Error text: `refusing to send credentials over plaintext: "<raw>" is plaintext and <host> is not this machine. The enrollment code, the machine credential and every command cross the network in the clear. Use https:// (plaintext is accepted only for localhost, 127.0.0.0/8 and ::1, for development)` (serverurl.go:35-37).
- `Canonical` (stored in config): Parse, drop query and fragment, trim trailing `/` of path, keep scheme as given (so a `wss://` base is stored as `wss://`) (serverurl.go:73-82).
- `HTTP`: ws->http, wss->https, append path (serverurl.go:43-55). `WebSocket`: https->wss, http->ws, append path (serverurl.go:58-70).

---

## 3. State and config

Default dir (state.go:57-65): `$HM_STATE_DIR` (trimmed) if set, else `$HOME/.hm` (via `os.UserHomeDir`), else `/var/lib/hm-computer`. No XDG. The systemd unit and both Dockerfiles set `HM_STATE_DIR=/var/lib/hm-computer`.

Files and directories written, all under the state dir:
| path | mode | writer | content |
|---|---|---|---|
| `<state>/` | 0700, tightened with chmod if group/other bits set | state.go:74-92 | |
| `<state>/credential` | 0600 | state.go:138-146 | the token, trimmed, plus `\n`. Plain text, no encryption, no keyring |
| `<state>/config.json` | 0600 | state.go:109-118 | pretty JSON (2-space indent) + `\n`: `{"url","machineId","name"(omitempty),"desktop"(omitempty)}` |
| `<state>/.tmp-*` | transient | state.go:154-183 | atomic write: CreateTemp in same dir, write, chmod, close, rename, chmod again |
| `<state>/audit.jsonl` (+ `.1`..`.N`) | 0600 (re-chmodded on open) | audit.go:96-114 | see section 6 |
| `<state>/running/` | 0700 | records.go:40 | process-group records |
| `<state>/running/<pgid>.json` | 0600 | records.go:39-55 | `{pgid, request_id, command(<=4096 bytes + "…"), started_at (RFC3339 UTC), start_time}` |
| `<state>/sessions/` | 0700 (MkdirAll, existing mode not tightened) | serve.go:98-104, policy.go:346-351 | default workdir; subdirs created on demand 0700 for exec cwd (policy.go:237) |
| `<state>/desktop/` | 0700, chmodded every start | desktop.go:175-185 | |
| `<state>/desktop/Xauthority` | 0600 | xauth.go:21-46 | binary Xauthority, one entry |
| `<state>/desktop/chromium-profile/` | Chromium-managed | packaging/desktop/chromium:8-12 | created by the image wrapper, not the Go code |
| `<state>/desktop/chromium-selftest-*` | MkdirTemp 0700, removed after | selftest.go:18-22 | |

Reading: credential missing or empty -> ErrNotEnrolled (state.go:121-134). Config missing -> ErrNotEnrolled; malformed JSON -> error. `IsEnrolled` = credential readable.

Ownership check (state.go:82-85, owner_unix.go): stat owner uid must equal `os.Getuid()`; else error `the state directory <dir> belongs to uid <n>, not to uid <m>; refusing to keep this computer's credential somewhere another user controls`. On non-unix it is skipped. Only the directory is checked, not the files inside.

`Ensure` is called by `run` (serve.go:72) and inside WriteCredential/SaveConfig (so also by `enroll`).

---

## 4. Connection (internal/conn)

- URL: `serverurl.WebSocket(config.URL, "/api/machines/computer")` (conn.go:26, 156-158). Base path is kept, e.g. `https://h/x` -> `wss://h/x/api/machines/computer`.
- Auth: header `Authorization: Bearer <credential>`, never in the URL (conn.go:206-208). No subprotocol, no other headers set.
- Dial timeout 20 s (conn.go:29). Read limit 8 MiB per message; exceeding closes the socket (conn.go:36, 218). Write timeout 30 s per frame, writes serialised by a mutex (conn.go:37, 367-376). Outbound frames over 8 MiB are refused before writing (conn.go:368-370).
- Hello: first frame after upgrade, JSON text (conn.go:228-234). Shape in section 5. Sent once per connection; fixed for the process life (capabilities detected once at startup).
- Heartbeat: client sends the bare text `ping` every 10 s (protocol.go:22, conn.go:319-343). Any `pong` resets the miss counter. After 2 consecutive unanswered pings it closes with WebSocket status 1008 (PolicyViolation), reason `no heartbeat answer`. A server `ping` text is answered with `pong` (conn.go:258-264). Read deadline per read = 2 x heartbeat + 5 s = 25 s; a read timeout ends the session (conn.go:115-119, 241-247). WebSocket protocol-level ping/pong control frames are not used (inferred: library handles control frames, code uses text literals).
- Inbound frames: binary messages ignored (conn.go:248-250). Text that is not JSON or has empty `id` is dropped with a warning, no reply (conn.go:274-278).
- Per frame on the read loop: `Prepare` (exec only: reserve request id; duplicate -> reply `duplicate_id`) then take one of 64 handler slots; if none free, reply `queue_full` with `this computer is already handling 64 requests` (conn.go:283-293). Then a goroutine runs `Dispatch`.
- Replies go back on the socket the request arrived on. If that socket closed, the reply is dropped and audited as `reply_dropped`, never resent on a new socket (conn.go:345-365). Work is bound to the daemon context, not the socket, so commands survive reconnects.
- Reply over 8 MiB is replaced by `frame_too_large` error `the reply is N bytes, over the 8388608 frame limit` (conn.go:357-361).
- On every session end: socket CloseNow, then `OnDisconnect` which abandons all in-progress uploads (conn.go:222-225, agent.go:41-43).
- permessage-deflate: the code passes no `CompressionMode` in `DialOptions` (conn.go:206-208), so it gets coder/websocket v1.8.15's default. The module cache is not on this machine, so whether that default negotiates compression is unknown, verify before porting. It matters because the 8 MiB read limit applies to decompressed payloads.
- JSON encoding: Go's `encoding/json` escapes `<`, `>`, `&` as `\u003c` etc. and replaces invalid UTF-8 with U+FFFD. Fixtures compare by meaning, so a serde encoder is fine, but the port's 8 MiB outbound guard must be measured on its own encoded bytes (`TestFrameGuardLeavesHeadroom` assumes up to 6x escaping of 1 MiB output).

Close-code handling and backoff (backoff.go, conn.go:161-202):
| condition | kind | next delay | log |
|---|---|---|---|
| HTTP 401 on upgrade | unauthorized | 5 min + uniform [0,150 s), step unchanged | Error `the server refused the machine credential; retrying slowly` |
| close 4400 | bad hello | same slow retry | Error `the server could not read this computer's hello and closed the connection; check --workdir and this client's version, because retrying will not change it` |
| close 4401 | revoked | none: Run returns ErrRevoked -> exit 3 | Error `the machine credential was revoked; this computer will not reconnect` |
| close 4409 | replaced | slow retry | Error `another connection took this credential over; waiting before trying again so the two do not evict each other` |
| close 4408, any other close, network error, other HTTP status | transient | exponential | Warn `disconnected; reconnecting` |
Exponential (backoff.go:85-115): if the session lasted >= 60 s, step resets to 0, else step++ capped at 6. Delay is uniform in [c/2, c] with c = min(1000 ms x 2^step, 60 s). So after the first short session the delay is 1-2 s (step 1), then 2-4, 4-8, 8-16, 16-32, 30-60 s. Step starts at 0 and the first failed dial goes to step 1. 401 on upgrade is not treated as revoked; only close code 4401 is terminal.

---

## 5. Protocol (internal/protocol/protocol.go)

v1, one JSON text frame per message, snake_case. `Version = 1` (protocol.go:11). New ops only behind a hello capability (protocol.go:3-5).

Constants: ping/pong literals; heartbeat 10,000 ms; close codes 4400/4401/4408/4409 (protocol.go:25-36); ChunkBytes 262,144; PlatformMaxFrameBytes 32 MiB; MaxFrameBytes 8 MiB; ExecOutputMaxBytes 1 MiB (protocol.go:40-50). `TestFrozenComputerConstants` (protocol_test.go:421) pins Version, ping/pong, 10 s, 4401, 4409, 4408, 262144 against `packages/protocol/src/computer.ts`.

### Client -> server
- Hello (protocol.go:103-115): `{type:"hello", protocol_version:1, hostname, os, arch, version, run_as_user, workdir, capabilities:{python3, git, skills, desktop, desktop_unavailable_reason}}`. `workdir` is the absolute, symlink-resolved sessions root. `desktop_unavailable_reason` is always present, null when fine, truncated to 256 runes (desktop.go:253-264). `skills` = python3 && git && `python3 -c "import pydantic"` succeeds within 10 s (state.go:213-236). `run_as_user` = passwd name, else `$USER`, else `uid-<n>` (state.go:196-204). Hostname = `--name`, else config `name`, else OS hostname.
- Reply (protocol.go:272-276): `{id, result}` or `{id, error:{code,message}}`, exactly one of the two keys (omitempty). EncodeError never fails; ultimate fallback literal `{"id":"","error":{"code":"op_failed","message":"reply encoding failed"}}` (protocol.go:290-300).
- Bare `ping` (every 10 s) and `pong` (answer to server ping).

### Server -> client (every request has `id`, `op`)
| op | fields | result |
|---|---|---|
| `exec` | `command` string, `cwd` string or null, `env` map, `timeout_ms` int | `{exit_code, stdout, stderr, bytes_total, truncated, duration_ms}` |
| `cancel` | `target_id` | `{cancelled: bool}` (true if id known, running, queued or reserved) |
| `file_put` | `transfer_id, path, seq, data_b64, final, sha256 (hex, final chunk only, nullable)` | `{bytes_written, sha256}`: per chunk bytes_written = chunk size and sha256 null; final = whole file size and verified digest |
| `file_get` | `path, offset, max_bytes` | `{data_b64, eof, size, sha256}`: sha256 only when offset 0, else null |
| `desktop_screenshot` | `quality` int 1-95 or null (=60) | `{data_b64, width, height, media_type:"image/jpeg"}` |
| `desktop_input` | `actions: [{type, x?, y?, button?, count?, dx?, dy?, keys?, text?}]` | `{ok:true}` |
| `desktop_clipboard_get` | none | `{text}` |
| `desktop_clipboard_set` | `text`, `selections: ["clipboard"|"primary"]` (1-2, no duplicates) | `{ok:true}` |
| other op | | error `unknown_op`: `this computer does not implement the op "<op>"` (agent.go:101-104) |

Desktop action types: `mouse_move`(x,y), `mouse_down`/`mouse_up`(button), `click`(x,y,button,count 1-3), `scroll`(x,y,dx,dy each within ±50, batch sum of |dx|+|dy| <= 60), `key`(keys 1-64 runes, regex `^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$`, not an xdotool command name case-insensitively), `type`(text 1-512 runes). Buttons `left|middle|right`. Coordinates 0..1279 x 0..799. Batch 1-64 actions. Clipboard text <= 65,536 bytes. Screenshot base64 <= 3 MiB (protocol.go:204-221, input.go:55-156, clipboard.go:26-44).

### Error codes (protocol.go:67-84, testdata/protocol/error_codes.json)
`bad_request, denied, desktop_unavailable, duplicate_id, frame_too_large, is_a_directory, not_a_regular_file, not_found, op_failed, queue_full, read_only, too_large, unknown_op`. `TestErrorCodeFixtureMatchesTheConstants` keeps the fixture and constants equal.

Mapping summary:
- exec: decode error -> bad_request; policy refusal or refused env -> denied; bad cwd -> bad_request; runner queue full -> queue_full; duplicate -> duplicate_id; other start refusal -> op_failed. A command that failed to start returns a normal result (exit 127), not an error (agent.go:107-186).
- files (agent.go:262-284): policy ErrDenied -> read_only if `--read-only` else denied; too many uploads -> queue_full; size -> too_large; directory -> is_a_directory; non-regular or symlink dest -> not_a_regular_file; ENOENT -> not_found; ErrBadRequest (bad seq, base64, digest mismatch, path changed) -> bad_request; else op_failed. file_get policy refusal is always `denied` (agent.go:236-243).
- desktop (agent/desktop.go:114-127): ErrBadRequest -> bad_request, ErrUnavailable -> desktop_unavailable, ErrTooLarge -> too_large, everything else including ErrBusy -> op_failed. Read-only refuses input and clipboard_set with read_only `this computer is read-only and refuses desktop input and clipboard writes`; screenshot and clipboard_get still work in read-only. No desktop -> desktop_unavailable `the desktop is not running on this computer; start the daemon with --desktop`. Validation runs before the read-only and no-desktop checks.

### Golden fixtures in testdata/protocol/
Tests compare by JSON meaning (protocol_test.go:31-44), decode-then-re-encode must be lossless (roundTrip), and the TS package reads the same files.
| file | pins |
|---|---|
| `client_to_server_hello.json` | hello shape, desktop false + reason null always present |
| `client_to_server_hello_desktop.json` | desktop true, reason null |
| `client_to_server_hello_desktop_unavailable.json` | desktop false with reason `chromium sandbox self-test failed: No usable sandbox!` |
| `client_to_server_reply_cancel.json` | `{id, result:{cancelled:true}}` |
| `client_to_server_reply_exec.json` | exec result keys; exit 124, truncated true, bytes_total > output |
| `client_to_server_reply_file_put.json` | `bytes_written` + `sha256` on final; also used by `TestEncodersMatchFixtures` to check EncodeOK output |
| `client_to_server_reply_file_get.json` | `sha256: null` on a non-zero offset window, `eof`, `size` |
| `client_to_server_reply_error.json` | `{id, error:{code:"denied", message}}`; checked against EncodeError output |
| `client_to_server_reply_desktop_screenshot.json` | data_b64/width/height/media_type |
| `client_to_server_reply_desktop_input.json` | `{ok:true}` |
| `client_to_server_reply_desktop_clipboard_get.json` | `{text:""}` (empty clipboard is empty string, not error) |
| `client_to_server_reply_desktop_clipboard_set.json` | `{ok:true}` |
| `server_to_client_exec.json` | exec with cwd string, env map (TFY_SESSION_ID), timeout_ms |
| `server_to_client_exec_null_cwd.json` | `cwd: null` stays null after round trip (TestExecNullCwdStaysNull), empty env |
| `server_to_client_cancel.json` | `target_id` |
| `server_to_client_file_put_chunk.json` | seq 0, final false, sha256 null |
| `server_to_client_file_put_final.json` | seq 1, final true, sha256 hex |
| `server_to_client_file_get.json` | offset 262144, max_bytes 262144 |
| `server_to_client_desktop_screenshot.json` | quality 60 |
| `server_to_client_desktop_screenshot_null_quality.json` | quality null distinct from absent/0 |
| `server_to_client_desktop_input.json` | every action type; absent fields stay absent on re-encode (pointer + omitempty, protocol.go:156-168) |
| `server_to_client_desktop_clipboard_get.json` | op with no fields |
| `server_to_client_desktop_clipboard_set.json` | text + both selections |
| `error_codes.json` | the full error-code set |

---

## 6. Exec runner, env policy, audit

### Running commands (internal/runner/runner.go)
- `/bin/sh -c <command>` (runner.go:289). Hard-coded path; the busybox image relies on it.
- `Setsid: true` -> own session and process group; pgid = child pid (runner.go:292, 312).
- cwd: request cwd resolved by policy (below), else `--workdir` resolved root (runner.go:369-374).
- Concurrency: `--max-concurrent` slots, `--max-queue` waiting; queue full -> ErrQueueFull (runner.go:244-267). Reservations: exec ids are reserved on the read loop before dispatch so a following cancel finds them (runner.go:122-131).
- Timeout: `timeout_ms <= 0` -> 30 s; capped at `--max-exec-seconds` (runner.go:281-287). On timeout: SIGKILL to `-pgid`, exit_code forced to 124 (runner.go:327-348).
- Cancel: running -> SIGKILL group, exit code from wait status (137); queued -> result exit 137, stderr `cancelled while queued`; reserved-not-started -> exit 137, stderr `cancelled before the command started` (runner.go:208-239). Those not-started cases audit as `error`.
- Start failure: exit_code 127, stderr = Go error text (runner.go:302-311).
- Exit code: `128 + signal` if signalled, else exit status (runner.go:379-392). WaitDelay 2 s so an escaped grandchild holding pipes does not hang the request.
- No stdin (inferred: Stdin not set, Go gives /dev/null). No PTY. No resource limits (rlimits, cgroups) applied by the client.
- Output (internal/runner/output.go): per stream budget 512 KiB; head = (524288-64)/2 = 262,112 bytes, tail = 262,112 bytes. If truncated, output is `head + "\n[... N bytes dropped ...]\n" + tail` with head/tail seams trimmed back to UTF-8 rune boundaries (at most 3 bytes). `bytes_total` = sum of all bytes written to both streams; `truncated` = either stream truncated. Output is put into a JSON string as Go `string(bytes)`; invalid UTF-8 is replaced with U+FFFD by encoding/json (inferred, stdlib).
- Env (runner.go:397-423): base `PATH` (daemon's or `/usr/local/bin:/usr/bin:/bin`), `HOME` (daemon's or `/tmp`), `LANG` (daemon's or `C.UTF-8`), `TERM=dumb`; then daemon `BaseEnv` (desktop `DISPLAY=:N`, `XAUTHORITY=<state>/desktop/Xauthority`); then request env (after policy filter). Keys that are empty or contain `=` or NUL, and values with NUL, are silently skipped. Nothing else from the daemon env is inherited, so the credential and `HM_*` never leak.
- Shutdown (runner.go:165-176): cancel all, then Sweep (kill recorded groups directly).

### Orphan sweep (internal/runner/records.go)
On start and shutdown, for each `<state>/running/*.json`: skip unparsable or pgid <= 1 (deleted). Kill `-pgid` with SIGKILL only if `kill(-pgid,0)` succeeds AND the recorded start_time is non-zero AND equals the current start time of pid pgid. Otherwise warn `not reaping a recorded process group: it can no longer be identified` with a reason and delete the record (records.go:67-128). Start time: Linux field 22 of `/proc/<pid>/stat` (clock ticks), parsed after the last `)` (starttime_linux.go); macOS `sysctl kern.proc.pid` `p_starttime` as sec*1e6+usec (starttime_darwin.go); other OS: unknown, never reaped.

### Local policy (internal/policy)
- Exec check (policy.go:168-202): read-only -> denied `this computer runs in read-only mode`; empty/whitespace command -> denied; NUL byte -> denied. Deny regexes (unanchored, RE2) tested against the whole command and each `\n`-split line; first match denies, message names the pattern. Allow regexes wrapped as `(?s)\A(?:<pat>)\z`; if any allow pattern exists, one must match. Go RE2 syntax; a Rust port with the `regex` crate is close but check flag/escape differences.
- `restricted` = read-only || workdir-only || any allow || any deny (policy.go:119).
- Env filter (env.go): always refuse names whose uppercase starts with `LD_` or `DYLD_`. If not restricted, accept everything else. If restricted, accept only: names granted by `--allow-env` (exact, case-sensitive; trailing `*` = case-sensitive prefix), or uppercase in {`LANG`,`TZ`,`TERM`,`NO_COLOR`,`CI`}, or uppercase prefix in {`LC_`,`TFY_`,`HM_SESSION_`}. Any refused name refuses the whole exec as `denied`: `refused by the local policy: this computer does not accept the environment variable(s) A, B from the server; add --allow-env to permit one` (sorted names) (agent.go:133-138).
- Exec cwd (policy.go:210-241): no cwd -> workdir. NUL -> error. `filepath.Abs` then resolve symlinks along the existing prefix. Exists and is a dir -> use it; exists, not a dir -> `working directory is not a directory: <p>`; missing and inside workdir -> MkdirAll 0700; missing elsewhere -> `working directory does not exist: <p>`. All return `bad_request`.
- File path check (policy.go:244-285): empty or NUL -> denied. `filepath.Abs` (relative paths resolve against the daemon's process cwd, not the workdir; inferred from stdlib). Resolve symlinks along the existing prefix, re-append missing tail. Always refuse anything inside the state dir unless inside the sessions dir: `<p> is inside the daemon's state directory`. If `--workdir-only`, refuse outside workdir: `<p> is outside the working directory`. Writes additionally refused in read-only.
- `within` compares by device+inode (os.SameFile) walking up the candidate's ancestors, so case-insensitive filesystems cannot bypass it; falls back to lexical `filepath.Rel` when the root does not exist (policy.go:292-321).
- Startup check: workdir overlapping the state dir (either inside the other) is refused unless the workdir is inside the sessions dir (policy.go:107-111). Message: `the working directory <w> overlaps the state directory <s>, which would expose the machine credential and the process-group records to the server; point --workdir somewhere else`.

### Audit log (internal/audit/audit.go)
- Path `<state>/audit.jsonl`, mode 0600 (chmod on every open), append-only, one JSON object per line.
- Fields (audit.go:22-38): `time` (RFC3339Nano UTC), `op`, `request_id`, `outcome` (`ok|denied|error|reply_dropped`), optional `command` (truncated to 4096 bytes + `…`), `cwd`, `path`, `exit_code`, `bytes`, `truncated`, `duration_ms`, `error`, `actions` (desktop_input action types only). Env values, typed text, key names and clipboard contents are never recorded.
- Rotation: before a write that would push the file past `--audit-max-bytes` (8 MiB), rename `.N-1`->`.N` ... live->`.1`, delete `.Keep`; with keep 0 the live file is deleted (audit.go:117-134).
- Audit write failure only logs a warning (`could not write the audit log`), never fails the op (agent.go:313-320).
- What gets recorded: every op outcome, including unknown ops, decode errors, denials, cancels (`command: "cancel <target>"`), file ops (`path`, `bytes`; for file_get `bytes` is the base64 length), desktop ops (bytes = base64 length for screenshots, text length for clipboard), and dropped replies.

---

## 7. Files (internal/files/files.go)

- Chunk size 256 KiB raw (before base64) both ways (protocol.go:42).
- Upload (`file_put`): base64 std decoding; chunk > 262,144 bytes -> bad_request; empty transfer_id or negative seq -> bad_request (files.go:134-147). A new transfer can be opened by any chunk with seq < 32 (window) and only if fewer than 8 transfers are open, else `queue_full` (files.go:172-188). Out-of-order chunks wait (condition variable) up to 60 s for their predecessor; max 32 waiting per transfer; already-written seq is answered idempotently with its length (files.go:192-251). On first in-order write: resolve the path through `policy.CheckWrite`, refuse a directory, symlink or non-regular destination, `MkdirAll(dir, 0700)`, `CreateTemp(dir, ".hm-upload-*")` chmod 0600 (files.go:256-304). Running size cap `--max-file-bytes` -> too_large. Final chunk: fsync, close, sha256 the temp file, compare with request `sha256` if given (mismatch -> bad_request), re-run CheckWrite and require the same resolved path, re-check destination type, copy existing destination's permission bits onto the temp file, rename over the destination (files.go:309-367). Any error discards the temp file and the transfer. Disconnect abandons all open transfers (temp files removed, destinations untouched).
- Download (`file_get`): policy CheckRead (allowed in read-only). Negative offset -> bad_request. Open with `O_RDONLY|O_NONBLOCK` (unix) so a FIFO does not block; fstat; directory -> is_a_directory; non-regular -> not_a_regular_file; size > `--max-file-bytes` -> too_large. Window = `max_bytes`, clamped to (0, 262144]. `ReadAt(offset)`. `eof = offset + read >= size`. On offset 0 the whole-file sha256 is computed and returned (files.go:400-456). Stateless: no download session.
- Roots: no fixed roots. Any absolute path the daemon user can reach, minus the state dir (except sessions), and confined to the workdir only with `--workdir-only`.

---

## 8. Desktop (Linux only; internal/desktop, packaging/desktop, Dockerfile.desktop)

- Display server: `Xvfb :<N> -screen 0 1280x800x24 -nolisten tcp -nolisten local -auth <state>/desktop/Xauthority` (desktop.go:157-168). Window manager: plain `openbox` (no args), started only after the display answers (desktop.go:170). Default display 99. Refused on non-Linux: `the desktop is only supported on Linux, not <goos>` (desktop.go:122-124).
- Pre-start checks: `Xvfb` and `openbox` on PATH, else `<bin> is not installed; see install.sh --desktop for the packages the desktop needs` (desktop.go:131-135; note the installer has no `--desktop` flag, this text is stale). Display lock `/tmp/.X<N>-lock`: if it names a live pid (kill 0 succeeds or EPERM) -> `display :<N> is already in use by process <pid>; stop it or pick another display with --desktop-display` (displaylock.go:36-45). Stale locks left for Xvfb.
- xauth: no `xauth` binary. A fresh 16-byte random MIT-MAGIC-COOKIE-1 per start, written in-process as a one-entry Xauthority file: family 0xFFFF (FamilyWild), empty address, display number string, name, cookie; big-endian u16 length prefixes; mode 0600 (xauth.go:10-46).
- X connection: in-process pure-Go X11 client (jezek/xgb) over the unix socket `/tmp/.X11-unix/X<N>` with the cookie (capture.go:34-53). Every connect first checks the lock file still names the Xvfb pid this desktop started (`ownsDisplay`, displaylock.go:48-61), else ErrUnavailable. Readiness: poll connect every 100 ms, 15 s budget at startup (desktop.go:205-234).
- Check after start (desktop.go:204-216): display answers within 15 s; `xdotool`, `xclip`, `chromium` on PATH (`<bin> is not on PATH`); then Chromium sandbox self-test: `chromium --headless=new --disable-gpu --no-first-run --user-data-dir=<tmp> --dump-dom about:blank`, 45 s timeout, own process group with Pdeathsig SIGTERM, killed by SIGKILL to group on timeout; passes if stdout contains `<html` (selftest.go:17-44). Failure reason: the stderr line containing `No usable sandbox` or `namespace` (text after `] `), else run error, else `it rendered nothing`. Any check failure stops the desktop and is reported in hello; the daemon keeps running.
- Supervision (supervise.go): Xvfb and openbox each restarted on exit, backoff 1 s doubling to 30 s, reset after 30 s of uptime. Each runs in its own process group (`Setpgid`), with `Pdeathsig: SIGTERM` on Linux; stop = SIGTERM to group, 5 s grace then kill (WaitDelay). Env = the same scrubbed env commands get (PATH/HOME/LANG/TERM + DISPLAY/XAUTHORITY), cwd = `<state>/desktop`.
- Input injection: `xdotool` subprocess per step, never chained across commands except mousemove+click (input.go:165-208). xdotool uses the XTEST extension (inferred; no uinput, no /dev/uinput, no evdev). Mapping: mouse_move -> `mousemove X Y`; mouse_down/up -> `mousedown|mouseup 1|2|3`; click -> `mousemove X Y click --repeat C --delay 0 B`; scroll -> `mousemove X Y`, then `click --repeat |dy| --delay 5 5|4` (5 = down for dy>0, 4 = up), then `click --repeat |dx| --delay 5 7|6` (7 = right for dx>0); key -> `key -- <keys>`; type -> `type --delay 2 --file -` with text on stdin (never argv). Budget 2 s + 5 ms per typed rune, whole batch; shares one slot with clipboard ops; an op that cannot get the slot in budget fails with ErrBusy (op_failed).
- Screenshot: in-process X11 `GetImage` ZPixmap of the root window, requires 32 bits per pixel, decodes with the root visual's RGB masks and image byte order, encodes JPEG with Go `image/jpeg` at the requested quality, base64; refuses > 3 MiB base64 as too_large `... ask for a lower quality` (capture.go:67-119). Budget 4 s; at most 2 concurrent captures. No external tool (no xwd, scrot, ImageMagick).
- Clipboard: `xclip -selection clipboard -o -t UTF8_STRING` for get (stdout capped at 64 KiB -> too_large; stderr containing `not available` -> empty string). Set: per selection `xclip -selection <clipboard|primary> -i` with text on stdin, own process group, no stdout/stderr pipes so the forked owner does not block (clipboard.go:48-111). Budget 2.5 s.
- Chromium wrapper (`packaging/desktop/chromium`, installed at `/usr/local/bin/chromium` in the desktop image): profile at `$(dirname $XAUTHORITY)/chromium-profile` (default `/var/lib/hm-computer/desktop/chromium-profile`); removes `SingletonLock/Cookie/Socket` if no running chromium uses that profile (pgrep); strips `--no-sandbox`/`--disable-setuid-sandbox` variants with a stderr note `chromium: ignored ...; the sandbox stays on`; execs `/usr/bin/chromium --user-data-dir=<profile> --password-store=basic --window-size=1280,800 --window-position=0,0 --disable-dev-shm-usage "$@"`. Managed policy `/etc/chromium/policies/managed/hm.json` = `{"PasswordManagerEnabled": false}`.
- openbox wrapper (`packaging/desktop/openbox` at `/usr/local/bin/openbox`): `exec /usr/bin/openbox --startup /usr/local/bin/hm-desktop-session "$@"`. Session script: `xsetroot -solid '#2b3a4a'`, `tint2 &`, `xterm &`. xterm app-defaults appended: select-to-clipboard, Ctrl+V / Ctrl+Shift+V / Shift+Insert paste CLIPBOARD.
- seccomp.json (`packaging/desktop/seccomp.json`): Docker's default profile (defaultAction ERRNO, 361-name allow list plus the standard arch and capability conditional blocks) with one added rule allowing `clone` and `unshare` unconditionally, commented `hm desktop: Chromium's sandbox creates user, PID and network namespaces without CAP_SYS_ADMIN`. `chroot` stays gated on CAP_SYS_CHROOT, hence the README's `--cap-add SYS_CHROOT`.
- Host binaries/packages the desktop needs: `Xvfb`, `openbox`, `xdotool`, `xclip`, `chromium` (all checked by the Go code); used by the image wrappers: `xsetroot` (x11-xserver-utils), `tint2`, `xterm`, `pgrep` (procps), fonts. Image package list: ca-certificates chromium fonts-dejavu-core fonts-liberation2 fonts-noto-color-emoji openbox procps tini tint2 x11-xserver-utils xclip xdotool xterm xvfb (Dockerfile.desktop:22-38). `/tmp/.X11-unix` must exist and be writable (image makes it 1777).
- No VNC/noVNC or streaming in the client; humans see the desktop only through screenshots (inferred from absence).

---

## 9. Service install

- `packaging/hm-computer.service` is a system unit (WantedBy=multi-user.target), installed by hand. No `install` subcommand in the binary; no unit is written by any script. README "Host service" (README.md:94-100): copy unit, binary to `/usr/local/bin/hm-computer`, create user and group `hm`, put `HM_URL` and first-boot `HM_ENROLL_CODE` in `/etc/hm-computer.env` (0600), `systemctl enable --now hm-computer`, remove the code afterwards.
- Unit contents: `Type=simple`, `User=hm`, `Group=hm`, `Environment=HM_STATE_DIR=/var/lib/hm-computer`, `EnvironmentFile=-/etc/hm-computer.env`, `ExecStart=/usr/local/bin/hm-computer run`, `Restart=always`, `RestartSec=5s`, `KillMode=control-group`, `KillSignal=SIGTERM`, `TimeoutStopSec=30s`, `StateDirectory=hm-computer`, `StateDirectoryMode=0700`, `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=full`, `ProtectHome=read-only`, `ProtectControlGroups=true`, `ProtectKernelTunables=true`, `After/Wants=network-online.target`.
- `Restart=always` also restarts after exit 3 (revoked), so a revoked machine loops every 5 s at the systemd level (inferred from unit; no `RestartPreventExitStatus=3`). Worth fixing in the port.
- The curl installer (`apps/web/src/server/releases/install-computer.sh`) is user-level: installs to `$HOME/.local/bin/hm-computer`, verifies sha256 from `<origin>/releases/hm-computer/latest.json`, optionally enrolls with `--code`, and tells the user to run `hm-computer run` themselves. It creates no service (user or system).

---

## 10. Logging, version, update

- Logging: Go `log/slog` to stderr, level Info fixed (no debug flag), JSON handler by default for `run`, text by default for `enroll`, selected by `--log-format` (main.go:81-86). `status` and `version` print plain text. Notable messages are quoted in sections 1 and 4. The X library's own logging is discarded (capture.go:26-29).
- Version: `var version = "0.0.0-dev"` stamped with `-ldflags "-X main.version=..."` (main.go:15-16). Release builds take `package.json` `version` (currently `0.1.0`) or `HM_COMPUTER_VERSION` (build-all.sh:6-13). Docker builds default to `0.0.0-docker` (ARG VERSION). Releases are built by `apps/web/scripts/publish-releases.ts:156-160`, which sets `HM_COMPUTER_VERSION`; the local release binary prints `0.1.0+e29151e7` (package version plus commit). Reported by `version`, in hello `version`, in enrollment `clientVersion`, in `status`.
- Update mechanism: none in the binary. Re-running the curl installer replaces the binary and says `Restart hm-computer to load the new version`. Docker users pull a new image.

---

## 11. Build

- `scripts/build-all.sh`: targets `linux/amd64 linux/arm64 darwin/amd64 darwin/arm64`, `go build -trimpath -ldflags "-s -w -X main.version=<v>"`, outputs `bin/hm-computer_<goos>_<goarch>` plus `bin/SHA256SUMS`. The names are a contract with `apps/web/src/server/releases/manifest.ts` and `apps/web/scripts/publish-releases.ts` (build-all.sh:19-21). No Windows build. (Code has `!unix` stubs, but `syscall.Kill` and `SysProcAttr.Setsid` in runner would not compile on Windows; inferred.)
- `scripts/go.sh`: host Go if present, else Docker `golang:1.23` with named cache volumes; exits 0 with a message when neither exists.
- `package.json` scripts: `build:local` (bin/hm-computer), `build:release`, `check` (vet + fmt:check + test), `docker:build` (hm-computer:local), `docker:build:desktop` (hm-computer-desktop:local), `fmt`, `fmt:check`, `test`, `test:desktop-image`, `test:race` (CGO on), `tidy`, `vet`.
- `Dockerfile` (headless): build stage `golang:1.23@sha256:60deed...`; runtime `busybox:1.37@sha256:9db7b5...` (needs `/bin/sh` for exec); copies CA bundle `/etc/ssl/certs/ca-certificates.crt`; `adduser -D -u 1000 hm`; `/var/lib/hm-computer` owned 1000:1000; `USER 1000:1000`; `ENV HOME=/tmp HM_STATE_DIR=/var/lib/hm-computer`; `VOLUME /var/lib/hm-computer`; `ENTRYPOINT ["/usr/local/bin/hm-computer","run"]`. No init process: the daemon is PID 1. Commands run in their own session, so a grandchild that outlives its shell is reparented to the daemon, which never reaps it and it stays a zombie (inferred; the tini comment in Dockerfile.desktop:20-21 says this is why the desktop image has an init). The port can inherit this or reap children itself.
- `Dockerfile.desktop`: same build stage; runtime `debian:bookworm-slim@sha256:3783cc...`; packages in section 8; wrappers copied to `/usr/local/bin/{chromium,openbox,hm-desktop-session}`; `useradd --create-home --uid 1000 hm`; `USER 1000:1000`; `ENV HOME=/home/hm HM_STATE_DIR=/var/lib/hm-computer`; `ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/hm-computer","run","--desktop"]` (tini reaps backgrounded chromium and xclip owners).
- CI: `.github/workflows/computer.yml` builds both images with context `apps/computer` and pushes to `ghcr.io/<owner>/agentum-computer[-desktop]` tagged `latest` and commit SHA, `workflow_dispatch` only. No `platforms:` key, so images are probably amd64 only (inferred).
- `scripts/test-desktop-image.sh`: builds the desktop image, runs `go test -tags desktop_integration` inside it with the custom seccomp profile (must pass) and with Docker's default profile (sandbox must be reported refused), then checks the chromium wrapper reopens a profile whose lock names an old hostname.
- `bin/` in the worktree holds local build outputs; it is gitignored, not tracked.

---

## 12. Privileges

- Root: refused unless `--allow-root` (state.go:187-192, serve.go:68-71), only in `run`. Message: `refusing to run as root: create an unprivileged user for this computer, or pass --allow-root if you accept the risk` (exit 2). `enroll` and `status` do not check.
- Specific uid: state dir must be owned by the running uid (state.go:82-85), message `the state directory <dir> belongs to uid <n>, not to uid <m>; refusing to keep this computer's credential somewhere another user controls`. Images run as uid 1000; unit runs as `hm`.
- Groups and capabilities: none checked or required by the binary. No capabilities used, no setuid, no /dev/uinput, no `input` or `video` group. Process control uses only same-uid `kill(-pgid)` and `/proc/<pid>/stat` reads.
- X socket: the daemon starts its own Xvfb as the same user, so no X socket permission issues beyond `/tmp/.X11-unix` being writable (image chmods it 1777) and `/tmp/.X<N>-lock` being creatable. Access is cookie-only (no TCP, no abstract socket).
- Chromium sandbox: needs unprivileged user namespaces on the host kernel; in Docker needs the custom seccomp profile (allows clone/unshare) and `CAP_SYS_CHROOT` when `--cap-drop ALL`. Failure is reported in hello as `chromium sandbox self-test failed: <reason>`, not fatal. The README's run line: `--shm-size=256m --cap-drop ALL --cap-add SYS_CHROOT --security-opt no-new-privileges --security-opt seccomp=packaging/desktop/seccomp.json`.
- systemd: system unit with `User=hm`; `NoNewPrivileges=true` (inferred: compatible with Chromium's namespace sandbox, which needs no setuid helper). `ProtectHome=read-only` means commands cannot write under /home and `ProtectSystem=full` makes /usr, /boot, /etc read-only for everything the agent runs (inferred from systemd semantics). `PrivateTmp=true` gives the daemon and its desktop a private /tmp, including `/tmp/.X11-unix` (inferred).
- Missing-permission messages the client prints are only the root and state-dir-owner messages above, plus generic wrapped OS errors (`create the state directory <dir>: <err>`, `restrict the state directory <dir>: <err>`, `create <path>: <err>` for sessions, `open <path>: <err>` for audit).

---

## Items a Rust port is most likely to get wrong

1. Go `runtime.GOOS/GOARCH` strings in hello and enrollment (`darwin`, `amd64`, `arm64`).
2. Single-dash and double-dash long flags both accepted by Go `flag`; subcommand `--help` exits 2.
3. Exact JSON key sets and null handling: `cwd: null`, `quality: null`, `sha256: null` vs absent, desktop action fields absent vs zero, hello always carrying `desktop` and `desktop_unavailable_reason`, reply with exactly one of `result`/`error`.
4. Heartbeat is app-level text `ping`/`pong`, not WebSocket control frames; 2 missed pings -> close 1008; 25 s read deadline.
5. Backoff: step resets only after a 60 s session; slow retry (5 min + 0-150 s) for 401, 4400, 4409; only 4401 is terminal.
6. Replies are never sent on a newer socket; commands survive reconnects; exec id reserved on the read loop before dispatch.
7. Output capping (head + tail + marker, rune-boundary trimming) and exit codes 124/127/137/128+n.
8. Process groups via setsid, SIGKILL to the group, records in `<state>/running` and start-time-verified sweep.
9. Symlink-resolving, inode-comparing path policy and the always-on state-dir exclusion.
10. Upload ordering window, idempotent redelivery, temp-file-then-rename with mode carry-over and the pre-rename re-check.
11. Xauthority binary format written in-process; in-process X11 GetImage capture; xdotool argument shapes and per-step invocation; xclip quirks.
12. `install-computer.sh` and the docker one-liners depend on the binary name, the `enroll`/`run`/`version` subcommands, `--url`/`--code`, `~/.hm/config.json` and `/var/lib/hm-computer`.

---

## Test names that pin behaviour (beyond protocol and main)

Listed so the port can mirror them as acceptance checks. All under `internal/`.

- conn: TestClassify, TestStepResetsOnlyAfterAStableConnection, TestTransientBackoffGrowsAndIsCapped, TestSlowRetriesAreAtLeastFiveMinutes, TestBackoffWindowIsHalfToFullCeiling, TestDialURLDerivation, TestCredentialTravelsInAHeaderNotTheURL, TestHelloCarriesTheProtocolVersion, TestRevokedIsTerminalAndNeverRetries, TestReplacedBacksOffForMinutes, TestStaleCloseReconnectsPromptly, TestUnauthorizedUpgradeRetriesSlowly, TestRequestIsAnsweredOnItsSocket, TestOversizedReplyIsRefusedNotSent, TestHalfOpenSocketIsClosedByTheHeartbeatCheck, TestFramesBeyondTheHandlerCapAreRefused, TestAFrameThatPrepareRefusesIsNotDispatched.
- runner: output head/tail and rune-boundary tests, TestDeadlineReports124AndKillsTheGroup, TestSignalledCommandReports128PlusSignal, TestEscapedGrandchildCannotHangTheCall, TestCancelKillsTheGroup, TestFourRunInParallelAndTheFifthWaits, TestQueueFullIsRefused, TestCancelWhileQueued, TestDuplicateRequestIDIsRefused, TestTheServersDeadlineIsCapped, TestEnvironmentIsScrubbed, TestBaseEnvReachesEveryCommand, TestScrubbedEnvIsSortedAndMinimal, the four Sweep tests (incl. TestSweepKillsASimpleCommandTheShellMayHaveExecedInto and TestSweepNeverKillsOnExistenceAlone), TestShutdownKillsTheGroupsItself, TestAStartFailureIsNotReportedAsStarted.
- files: TestPipelinedChunksArriveInAnyOrder, TestARedeliveredChunkIsIdempotent, TestAChunkWhosePredecessorNeverArrivesGivesUp, TestATransferCannotOpenBeyondTheWindow, TestAFailedUploadLeavesTheOriginalIntact, TestASymlinkSwappedInMidTransferIsRefused, TestNonRegularFilesAreRefusedForDownload, TestSizeCapsApplyBothWays, TestOpenTransfersAreCapped, TestUploadedFileIsOwnerOnly, TestGetWindowIsClampedToTheChunkSize.
- policy: env tests (TestMatchingIgnoresCase checks `ld_preload` refused and `lang`/`lc_all` accepted when restricted), TestDenyIsCheckedPerLine, TestAllowListIsExclusiveAndAnchored, TestWorkdirOnlyRejectsAPrefixSibling, TestWorkdirOnlyFollowsSymlinks, TestStateDirectoryIsProtectedInEveryMode, TestAWorkdirOverlappingTheStateDirIsRefused, TestWithinComparesIdentityNotText.
- state: credential mode tests, TestStateDirResolution, TestRootIsRefusedWithoutTheFlag, TestDetectCapabilitiesReportsSkillsOnlyWhenTheImportSucceeds.
- agent: TestACommandSurvivesADisconnectAndACancelOnTheNextSocket, TestACancelThatOvertakesItsExecStillCounts, TestEnvironmentInjectionIsRefusedNotStripped, TestARefusedExecReleasesItsReservation, TestAnUploadPreservesTheDestinationsMode, TestDroppedReplyIsAudited, TestAuditNeverRecordsEnvironmentValues, desktop tests (ops without desktop, limits, read-only, audit records types not content).
- desktop (unit): TestWriteXauthorityFormatAndMode, TestStepsForEachAction (exact xdotool argv), TestKeyChordsThatPass/AreBadRequests, TestScrollBudgetIsPerBatch, TestInputBudgetFollowsTheContract, TestPixelLayoutDecode, TestConnectNeverDialsSomeoneElsesDisplay, TestADisplayHeldByALiveProcessIsRefused, the three "cannot start in its budget" tests, TestScreenshotSlots, TestSelfTestFailureNamesTheSandbox.
- desktop integration (`-tags desktop_integration`, run inside the desktop image by `scripts/test-desktop-image.sh`): `internal/agent/desktop_integration_test.go`.
- enroll and serverurl: TestRedirectsAreRefused, TestBothTokenPrefixesAreAccepted, TestAnEmptyCodeIsRefusedWithoutACall, TestPlaintextIsRefusedExceptToThisMachine, TestCanonicalStripsTheExtras, TestIsLoopback.
