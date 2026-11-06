# Server contract and release pipeline for a single Rust machine client

Repo read: `/home/roboto/devel/harbourmaster-wt/deploy-ep` at `e29151e7` (read-only).
All paths below are relative to that root. "(inferred)" marks anything not read directly.

## 1. Wire contracts

### How the routes are mounted

- `apps/web/src/server.ts:100-103` mounts the release routes (`/install.sh`, `/install-computer.sh`, `/releases/*`) before Clerk, with the R2 `FILES` bucket.
- `apps/web/src/server.ts:151-159` adds `clerkMiddleware()` everywhere, then the `composeServices` middleware on `/api/*`, `/mcp`, `/mcp/*`, `/files/*`.
- `apps/web/src/server.ts:245` mounts `runtimeRoutes` at `/`.
- `apps/web/src/server/routes/runtime.ts:19-34` mounts `machineRoutes()` at `/api/machines`, `desktopRoutes` at `/api/machines/:id/desktop`, and `filesRoutes`, `libraryRoutes`, `skillsRoutes`, `runLibraryRoutes` at `/` (full paths), `sessionStreamRoutes` at `/api/sessions`.
- `apps/web/src/server/routes/machines.ts:88-124` defines `/enroll`, `/connect`, `/computer`, and mounts `machineRunRoutes()` at `/runs` (`machines.ts:121`).
- Machine routes are a `bearerGroup()` (no csrf), `routes/groups.ts:25-33`.

### Token prefixes (`packages/protocol/src/token-prefixes.ts`)

Every prefix is accepted as `ag_<kind>_` or `hm_<kind>_` (`token-prefixes.ts:32-53`).
Run token, machine credential and enrol code are still issued as `hm_` (`token-prefixes.ts:55-65`: `RUN_TOKEN`, `MACHINE_CREDENTIAL`, `ENROLL_CODE` built with `"legacy"`).
The comment at `token-prefixes.ts:55-58` says installed clients "know only `hm_`". That is stale for the current clients: `apps/computer/internal/enroll/enroll.go:151` accepts both, and `apps/daemon/src/config.ts:25` uses `MACHINE_CREDENTIAL.matches` (both). The Rust client must accept both, and the server can switch to issuing `ag_` once every older binary is gone.

### Endpoints the machine clients call

| # | Method + path | Caller | Auth | Server code | Schemas | Fixtures |
|---|---|---|---|---|---|---|
| 1 | `POST /api/machines/enroll` | both | none, the body carries an `hm_enr_` code | `routes/machines.ts:91-115` -> `services/src/machines.ts:350-394` | request `machineEnrollRequestSchema` = union of daemon `enrollRequestSchema {code, singleUser}` and `computerEnrollRequestSchema {arch, clientVersion, code, hostname, os, role:"computer"}` (`protocol/src/machine.ts:62-87`); response `enrollResponseSchema {credential, machineId}` (`machine.ts:89-93`). 400 bad body, 401 bad/expired/used/wrong-role code. | `packages/protocol/fixtures/enroll-request.json`, `enroll-response.json` (daemon); `apps/computer/testdata/enroll/request.json`, `response.json` (read by `apps/computer/internal/enroll/enroll_test.go:21`) |
| 2 | `GET /api/machines/connect` (WebSocket) | daemon | `Authorization: Bearer hm_mach_` opened as role `agent_host` | `routes/machines.ts:117`, `upgradeToRelay` `machines.ts:54-86` | frames below | `packages/protocol/fixtures/hello.json`, `ping.json`, `hello-ack.json`, `offer.json`, `cancel.json`, `library-changed.json` |
| 3 | `GET /api/machines/computer` (WebSocket) | computer | `Bearer hm_mach_` opened as role `computer` | `routes/machines.ts:119` | frames below | `apps/computer/testdata/protocol/*.json` (read by `packages/protocol/src/computer.test.ts:13`) |
| 4 | `POST /api/machines/runs/:runId/claim` | daemon | `Bearer hm_mach_`, `authenticate()` with default role `agent_host` (`machine-runs.ts:59-64`) | `machine-runs.ts:95-125` -> `runs.claimRunForMachine` | request header `X-Daemon-Features` (`machine.ts:26-46`: `library-sync`, `requests`, `current-approvals`, `library-live`); response `claimResponseSchema` (`machine.ts:158-218`, strict) | `packages/protocol/fixtures/claim-response.json` |
| 5 | `POST /api/machines/runs/:runId/events` | daemon | same | `machine-runs.ts:127-142` | `eventsRequestSchema` / `eventsResponseSchema` (`machine.ts:220-240`) | `events-request.json`, `events-response.json`; `apps/daemon/fixtures/tool-run/events.json` |
| 6 | `POST /api/machines/runs/:runId/heartbeat` | daemon | same | `machine-runs.ts:144-150` | empty body, `{}` response (`machine.ts:242`) | `heartbeat-response.json` |
| 7 | `POST /api/machines/runs/:runId/complete` | daemon | same | `machine-runs.ts:152-167` | `completeRequestSchema` (`machine.ts:260-271`, `done`/`failed`(+`stop`)/`aborted`) | `complete-request-{done,failed,aborted}.json`, `complete-response.json`; `apps/daemon/fixtures/tool-run/complete.json` |
| 8 | `POST /api/machines/runs/:runId/needs-approval` | daemon | same | `machine-runs.ts:169-184` | inline zod `{toolKey}` -> `{required}` | none found |
| 9 | `POST /api/machines/runs/:runId/requests` | daemon | same | `machine-runs.ts:186-222` | `createRequestBodySchema` / `createRequestResponseSchema` (`machine.ts:276-289`), displays in `protocol/src/requests.ts` | none found |
| 10 | `GET /api/machines/runs/:runId/requests/:requestId?wait=<s>` | daemon | same | `machine-runs.ts:224-240` (long poll, service caps at 25 s, `machine-runs.ts:75`) | `waitRequestResponseSchema` (`machine.ts:291-295`) | none found |
| 11 | `GET /files/:id` | daemon | `Bearer hm_run_` run token (from the claim) | `routes/files.ts:278`, run auth `files.ts:165-201` | binary body | none |
| 12 | `POST /api/files` (multipart, field `file`) | daemon | `Bearer hm_run_` | `routes/files.ts:233-275` | `{id}` response | none |
| 13 | `GET /api/runs/:id/skills`, `GET /api/runs/:id/skills/file?path=` | daemon | `Bearer hm_run_` | `routes/skills.ts:32-35, 52, 72` | `skillsListResponseSchema` (`protocol/src/skills.ts`) | none |
| 14 | `/api/runs/:id/library/{list,stat,file(GET/PUT/DELETE),conflicts}` | daemon | `Bearer hm_run_` naming that run | `routes/run-library.ts:149-261`, registered at `run-library.ts:263` | `protocol/src/library.ts` (`libraryListResponseSchema`, `libraryStatResponseSchema`, `libraryWriteResponseSchema`, `libraryConflictRequestSchema`) | none |
| 15 | `/mcp` | the Claude Agent SDK inside the daemon, not the daemon's own code | `Bearer hm_run_` | URL comes from the claim's `mcpServers` built by `services/src/connectors/mcp-servers.ts:24-27` (`${platformUrl}/mcp`), `platformUrl` is the origin the daemon reached (`machine-runs.ts:121`) | MCP | n/a |

Client call sites, for cross-checking: `apps/daemon/src/enroll.ts:18`, `client.ts:64-70`, `run-api.ts:105`, `files-api.ts:156,191`, `skills-api.ts:65`, `library-api.ts:76`; `apps/computer/internal/enroll/enroll.go:20`, `internal/conn/conn.go:26,207`. The computer client calls only rows 1 and 3.

Not called by either machine client, but sharing the relay or services: `GET /api/machines/:id/desktop`, `/clipboard`, `/stream` (Clerk session, viewer WebSocket into the same DO, `routes/desktop.ts`), `/api/sessions/:id/stream` (`routes/session-stream.ts`), `GET /api/library/download` (cookie, `routes/library.ts:34`), `/api/session/library/*` (managed session tokens, `run-library.ts:264-270`).

### WebSocket termination

- Both sockets end in the `MachineRelay` Durable Object, one object per machine via `idFromName(machineId)` (`routes/machines.ts:82-85`; class `apps/web/src/server/relay.ts:40-74`, binding `MACHINE_RELAY` in `apps/web/wrangler.jsonc:10`).
- The Worker authenticates, copies only the upgrade headers (`machines.ts:24-31`), and stamps `x-hm-machine-id`, `x-hm-workspace-id`, `x-hm-role` (`machines.ts:78-81`, `relay-core.ts:18-25`). The client cannot set them.
- A failed credential is never an HTTP 401. The Worker accepts the upgrade and closes it at once with 4401 (`machines.ts:33-47`). A non-upgrade request gets 426 (`machines.ts:59-61`).
- Sockets are accepted with the hibernation API under a tag: `daemon`, `computer` or `viewer` (`relay.ts:118`; dispatch `machine-relay-core.ts:98-108`). Daemon logic is `relay-core.ts`, computer logic `computer-relay-core.ts`, viewers `viewer-hub.ts`. One DO alarm is shared through `relay-alarms.ts`.

### Frame families

The two protocols differ in every surface detail, which matters most for one binary.

Daemon socket (`packages/protocol/src/machine.ts`, camelCase JSON text frames, no version field):
- client -> server: `hello {type, agents[], capabilities{agentSdk, container}, daemonVersion, features?[]}` (`machine.ts:95-110`), `ping {type, at}` (`machine.ts:112-116`). Heartbeat is a JSON frame, never a bare `ping` (`relay.ts:62-63`).
- server -> client: `hello_ack {machineId, serverTime}`, `offer {agentId, runId}`, `cancel {runId}`, `library_changed {paths[]}` (only to sockets whose hello listed `library-live`) (`machine.ts:124-156`, `relay-core.ts:306-326`).
- Close codes: 4401 credential rejected (stop), 1012 replaced by a newer connection (`machine.ts:50-53`, `relay-core.ts:198-218`).
- Unparseable frames are ignored, not fatal (`relay-core.ts:229-241`).

Computer socket (`packages/protocol/src/computer.ts`, snake_case JSON, `protocol_version: 1`, header comment says frozen, `computer.ts:1-11`):
- client -> server: `hello` with `protocol_version`, `hostname`, `os`, `arch`, `version`, `run_as_user`, `workdir`, `capabilities{python3, git, skills, desktop, desktop_unavailable_reason}` (`computer.ts:42-58, 96-107`); replies `{id, result}` or `{id, error{code, message}}` (`computer.ts:438-452`); bare text `ping`.
- server -> client: requests `{id, op, ...}` with ops `exec`, `cancel`, `file_put`, `file_get`, `desktop_screenshot`, `desktop_input`, `desktop_clipboard_get`, `desktop_clipboard_set` (`computer.ts:120-153, 276-328`; the `id` envelope is seen in `apps/computer/testdata/protocol/server_to_client_exec.json`); bare text `pong`, answered by the platform without waking the DO (`relay.ts:119-124`).
- Close codes: 4400 unreadable hello, 4401 revoked (terminal), 4408 stale heartbeat, 4409 replaced (`computer.ts:26-32`).
- Limits: frame 4 MiB, file chunk 256 KiB, 4 in-flight execs, queue 32 (`computer.ts:23-40`).
- Handshake: `connect` bumps a generation and closes older sockets with 4409 (`computer-relay-core.ts:804-821`), `accepted` stamps the socket with that generation (`:824-834`), and only the current generation's hello is taken (`:874-887`). A bad hello closes with 4400 (`:866-872`).

## 2. Machine records and roles

Schema: `packages/db/src/schema/machines.ts`. Role enum `MACHINE_ROLES = ["agent_host", "computer"]` (`packages/db/src/shared.ts:67`).

There is no role column on `machines`. Roles are derived (`packages/services/src/machines.ts:131-137`):
- `agent_host` when `credential_hash` does not start with `computer-only:` (`schema/machines.ts:30-36`, `machines.ts:59-65`).
- `computer` when `computer_status` is not null (`schema/machines.ts:27-28`).

Per-role state lives in separate columns: `status`, `last_seen_at`, `capabilities`, `daemon_version` for the daemon; `computer_status`, `computer_last_seen_at`, `computer_capabilities` for the computer (`schema/machines.ts:20-48`). `revoked` sits on `status` and covers both roles (`machines.ts:463-529`).

Credentials:
- Daemon: SHA-256 of the `hm_mach_` token in `machines.credential_hash` (`schema/machines.ts:36`).
- Computer: a row in `machine_credentials (machine_id, role, credential_hash)` (`schema/machines.ts:79-91`), which the comment says holds `computer` credentials only.
- `authenticate(authorization, role = "agent_host")` opens exactly one role (`machines.ts:424-445`): `computer` looks in `machine_credentials` (`machines.ts:397-416`), `agent_host` in `machines.credential_hash` via `findMachineByCredential` (`services/src/workspaces.ts:475-492`).
- `machine-runs.ts:59-64` calls `authenticate` with no role, so a computer credential can never reach the run routes.
- `createPrincipalResolver` maps `hm_mach_`/`ag_mach_` to `findMachineByCredential` only (`workspaces.ts:652`). A computer credential is therefore invisible on `/mcp`, `/api/proxy` and the other bearer routes; a daemon credential resolves to a `machine` principal there.

Enrolment:
- Codes: `machine_enroll_tokens` with `role` and optional `machine_id` (`schema/machines.ts:50-71`), 15 min TTL (`machines.ts:55`), single use via one conditional `UPDATE ... RETURNING` (`machines.ts:356-372`).
- `createEnrollToken` (`machines.ts:231-270`, tRPC `machines.createEnrollToken` in `apps/web/src/server/trpc/machines-router.ts:21`): with `machineId` only `role: "computer"` is allowed (`machines.ts:242-247`), and the machine must be live with no computer yet (`machines.ts:202-224`).
- `enroll` matches the code's role to the body shape (`machines.ts:354, 362`). A daemon body always makes a new row (`machines.ts:379-393`). A computer body makes a computer-only row or adds a credential to the named row (`machines.ts:277-340`).

Can one row hold both roles today? Yes. The row has columns for both, `rolesOf` returns both, and the UI shows one line per role. What is missing is a single enrolment and a single credential:
- The only path to a both-role row is two enrolments, in order: an `agent_host` code (new row, daemon credential), then a second `computer` code minted with that `machineId` from "Add computer role" (`machine-logic.ts:57-63`, `enroll-dialog.tsx:141-145`). The result is two different `hm_mach_` tokens.
- The reverse order is refused: you cannot add `agent_host` to a computer-only machine (`machines.ts:242-247`).

Options for a single Rust client:

A. No server change. The client enrols twice and stores two credentials, one per socket. Works today, but the user needs two codes, and the second code can only be minted after the first enrolment created the row.

B. One enrolment, one credential, both roles. Concrete changes:
1. Protocol: a new enrol body, for example `role: "both"` or `roles: ["agent_host","computer"]` with the computer fields, in `machineEnrollRequestSchema` (`protocol/src/machine.ts:62-87`), plus a matching code role. The `role` columns carry no SQL CHECK (`packages/db/migrations/0020_burly_master_mold.sql:11-25`, plain `text`), so a new value is a TypeScript change and needs no migration. Do not add it to `MACHINE_ROLES` itself (`shared.ts:67`), because that type also drives `MachineRecord.roles` and `ROLE_LABELS: Record<MachineRole, string>` (`machine-logic.ts:5-8`). A separate enum for the code's kind on `machine_enroll_tokens.role` is cleaner (inferred design choice).
   Today the computer body's `arch`, `clientVersion`, `hostname` and `os` are validated by the strict schema and then dropped: `enrollComputer` gets only the token row (`machines.ts:277-282, 376-378`). The client must send them, but their values do not reach D1. `computer_capabilities` is filled from the hello (`machines.ts:666-679`).
2. Service `enroll` (`machines.ts:350-394`): insert the row with a real daemon `credential_hash` and `computer_status = "offline"` in one `atomic` write, and insert a `machine_credentials` row with the same hash (`role: "computer"`). Same hash in both tables lets today's `authenticate` open both roles with one token. The unique index on `machine_credentials.credential_hash` (`schema/machines.ts:90`) allows it, since the hash is unique per table. The schema comment at `schema/machines.ts:73-78` ("Holds computer credentials only") becomes wrong, and `findComputerByCredential` already checks `role = "computer"`, so no lookup change is needed. (inferred: no test asserts the two hashes differ; check `services/src/machines.test.ts` before relying on it.)
   Alternative: make `authenticate` look up both tables for either role. That is a larger change, because it would also let a computer-only token open the daemon socket unless guarded by `rolesOf`.
3. `createEnrollToken` (`machines.ts:231-270`) and `enrollTokenInputSchema` (`machines.ts:85-94`): accept the new role.
4. Routes: `/connect` and `/computer` already check role per socket (`routes/machines.ts:117-119`), and the DO already holds both sockets under one identity (`relay.ts:40-50`), so they need no change. A single WebSocket carrying both protocols would be a much larger change to `relay.ts` and `machine-relay-core.ts` and is not needed.
5. UI: `enroll-dialog.tsx:31-41, 172-195` offers one role per code, and the install commands are role-specific. It would need a third choice or a both-role default, plus one install command. `machine-logic.ts` already renders per-role rows (`roleRows`, `machine-logic.ts:39-44`) and needs no change for listing.
6. Revoke already ends both roles (`machines.ts:463-529`). Revoking only one role is not supported today.

Product note: `attachComputer` lets only `cloud` and `managed` agents drive a computer (`machines.ts:75-76, 759-764`). The computer role on a both-role machine serves a different agent than the machine agents its daemon runs. A single binary does not change that.

## 3. Release and install

### Build and publish

| Item | Detail | Source |
|---|---|---|
| Products | `agentum` (daemon) and `hm-computer` | `apps/web/src/server/releases/manifest.ts:7` |
| Files | `agentum-linux-x64`, `agentum-linux-arm64`; `hm-computer_linux_amd64`, `_linux_arm64`, `_darwin_amd64`, `_darwin_arm64` | `manifest.ts:14-22` |
| Daemon build | `bun build --compile --minify --target=bun-linux-{x64,arm64} src/main.ts --define process.env.HM_DAEMON_VERSION=<version>` | `apps/web/scripts/publish-releases.ts:133-154`; also `apps/daemon/package.json` scripts `build`, `build:release` |
| Computer build | `apps/computer/scripts/build-all.sh`, `go build -trimpath -ldflags "-s -w -X main.version=$HM_COMPUTER_VERSION"` for linux/darwin x amd64/arm64, writes `bin/SHA256SUMS` (not uploaded) | `build-all.sh:17-33`, `publish-releases.ts:156-160` |
| Version | `<apps/daemon/package.json version>+<git short sha>`, the same string for both products | `manifest.ts:24-39`, `publish-releases.ts:58-59, 78, 266-268` |
| Storage | R2 bucket bound as `FILES`: `agentum-v2-files` (production), `agentum-v2-staging-files` (staging). Keys `releases/<product>/<version>/<file>` and `releases/<product>/latest.json` | `apps/web/wrangler.jsonc:134, 234`; `manifest.ts:10-50`; `publish-releases-helpers.ts:202-215` |
| Upload | `wrangler r2 object put --remote [--env staging]`, binaries first, `latest.json` last; a product whose `latest.json` already names this version is skipped; refuses a dirty tree unless `--allow-dirty` | `publish-releases.ts:67-108, 199-261`; helpers `shouldSkip`, `assertCleanTree` |
| How it runs | By hand: `bun scripts/publish-releases.ts --env staging|production` from `apps/web`. No GitHub workflow publishes binaries | `publish-releases.ts:7-8`; `.github/workflows/` has only `ci.yml`, `computer.yml`, `preview.yml` |
| Manifest | `{product, version, files: {<name>: {sha256, size}}}`, strict zod; written one key per line so the install scripts parse it with `sed`/`awk`. That line format is a contract | `manifest.ts:52-85` |
| Integrity | SHA-256 per file in `latest.json`, checked by the install scripts. No signing anywhere | `install.sh:112-160`, `install-computer.sh:98-147` |

### Routes (`apps/web/src/server/routes/releases.ts`)

- `GET /install.sh`, `GET /install-computer.sh`: the script with `@@HM_ORIGIN@@` replaced by the request origin, `max-age=60` (`releases.ts:51-64`, `releases/install-script.ts:4-8`).
- `GET /releases/<product>/latest.json`: manifest from R2, `max-age=60` (`releases.ts:66-82`).
- `GET /releases/<product>/<version>/<file>`: binary from R2, immutable cache, ETag/304; only names in `PRODUCT_FILES` with a valid version are served (`releases.ts:84-110`, `manifest.ts:92-99`).
- Everything else under `/releases/*` is 404 (`releases.ts:114`).

### Install scripts

`apps/web/src/server/releases/install.sh` (daemon):
- Linux x64/arm64 only (`install.sh:98-110`). Installs to `~/.local/bin/agentum`, config `~/.agentum/config.json`, legacy `~/.harbourmaster/config.json` (`install.sh:13-21`).
- Fresh machine: `agentum install-service` (systemd user unit; exit 2 means lingering off), then `agentum enroll <code> --server <origin>` (`install.sh:186-240`).
- Re-run on an enrolled machine replaces the binary and runs `install-service --refresh` (`install.sh:245-262, 282-287`).
- Prints `agentum --version`, stripping a `[agentum] ` prefix (`install.sh:264-271`). Warns if `claude` is not on PATH (`install.sh:173-177`).

`apps/web/src/server/releases/install-computer.sh`:
- Linux and macOS, amd64/arm64 (`install-computer.sh:82-96`). Installs `~/.local/bin/hm-computer`, config `~/.hm/config.json` (`:14-16`).
- With `--code` and no config: `hm-computer enroll --url <origin> --code <code>`, then tells the user to run `hm-computer run` (`:159-164`). No service is installed. A systemd system unit ships separately at `apps/computer/packaging/hm-computer.service` (user `hm`, `HM_STATE_DIR=/var/lib/hm-computer`, `EnvironmentFile=/etc/hm-computer.env` with `HM_URL` and `HM_ENROLL_CODE`).
- Prints `hm-computer version` (`:179-183`).

The CLI surfaces differ (`enroll <code> --server` vs `enroll --url --code`; `--version` vs `version`). A Rust binary replacing both must either keep both spellings or ship new scripts in the same deploy.

### Commands shown on the Machines page

Built in `apps/web/src/components/machines/enroll-commands.ts`, shown by `enroll-dialog.tsx:172-195`. `<origin>` is `window.location.origin` (`enroll-dialog.tsx:158`), `<code>` the minted code.

Role `agent_host` ("Runs the agent"), one command (`enroll-commands.ts:12-16`, `enroll-dialog.tsx:194`):

```
curl -fsSL <origin>/install.sh | sh -s -- --code <code>
```

Role `computer`, three commands (`enroll-dialog.tsx:174-191`):

"Docker, headless" (`enroll-commands.ts:18-24`):
```
docker run -d --restart unless-stopped --name hm-computer \
  -v hm-computer:/var/lib/hm-computer \
  ghcr.io/codewithpassion/agentum-computer:latest \
  --url <origin> --code <code>
```

"Docker, with a desktop" (`enroll-commands.ts:26-35`), with the note "Chromium needs the seccomp profile packaging/desktop/seccomp.json from the apps/computer folder of the repository. Run this command from inside apps/computer." (`enroll-commands.ts:5-6`):
```
docker run -d --restart unless-stopped --name hm-computer-desktop \
  --shm-size=256m --cap-drop ALL --cap-add SYS_CHROOT \
  --security-opt no-new-privileges \
  --security-opt seccomp=packaging/desktop/seccomp.json \
  -v hm-computer-desktop:/var/lib/hm-computer \
  ghcr.io/codewithpassion/agentum-computer-desktop:latest \
  --url <origin> --code <code>
```

"Binary" (`enroll-commands.ts:37-41`), Linux and macOS:
```
curl -fsSL <origin>/install-computer.sh | sh -s -- --code <code>
```

The update hint on a machine row uses the bare daemon installer, `curl -fsSL <origin>/install.sh | sh` (`machine-row.tsx:82-95`, `enroll-commands.ts:12-13`).

No platform switch exists in the UI. The platform is picked by the install script from `uname`.

### Docker images

- `apps/computer/Dockerfile`: Go build, then busybox, `ENTRYPOINT ["hm-computer","run"]`, state volume `/var/lib/hm-computer`, uid 1000.
- `apps/computer/Dockerfile.desktop`: Debian bookworm-slim with Xvfb, openbox, Chromium, xdotool, xclip, tini; `ENTRYPOINT ["tini","--","hm-computer","run","--desktop"]`.
- Published to `ghcr.io/<owner>/agentum-computer` and `agentum-computer-desktop`, tags `latest` and the commit sha, by `.github/workflows/computer.yml` on `workflow_dispatch` only. The image version is `ARG VERSION=0.0.0-docker` and the workflow does not pass it, so images report `0.0.0-docker` (inferred from `Dockerfile:10-12` and `computer.yml:37-57`, not checked against a pulled image).
- The page hardcodes owner `codewithpassion` (`enroll-commands.ts:1-3`).
- There is no Dockerfile for the daemon.

### Version checks and updates

- `machines.newestDaemonVersion` (tRPC, `machines-router.ts:29`; service `machines.ts:531-543`) reads `latest.json` of `agentum` from R2 (`apps/web/src/server/compose.ts:1463-1470`).
- `isDaemonOutdated` (`machine-logic.ts:65-79`) flags any machine whose `daemon_version` differs from that string (exact string inequality, no ordering). The row then shows "Daemon update available (<version>)" with the install command (`machine-row.tsx:82-95`).
- `daemon_version` comes from the daemon hello (`relay-core.ts:244-263`, `machines.ts:551-598`). A Rust binary must report the exact `<pkg>+<sha>` string that `publish-releases.ts` writes, or every row looks outdated.
- The computer client's `version` is stored as `computerCapabilities.clientVersion` (`machines.ts:669-675`) and never compared. There is no computer update hint.
- No minimum version, no forced upgrade, no self-update channel. No `/releases` path appears in either client tree (path grep, not a full read).

## 4. Differences per role on the server

Daemon (`agent_host`):
- WS heartbeat: JSON `ping` every `HEARTBEAT_SECONDS = 20` (`machine.ts:49`, `apps/daemon/src/client.ts:19`).
- Offline when silent for `PRESENCE_TIMEOUT_MS = LEASE_SECONDS * 1000 = 90 s` (`machine.ts:48`, `relay-core.ts:27-28`), detected by the DO alarm (`relay-core.ts:276-288`), or at once when the last daemon socket closes (`relay-core.ts:291-303`).
- `last_seen_at` is written at most every 120 s (`relay-core.ts:30-35`).
- Each hello marks online, stores `capabilities` (with `daemonVersion` merged in) and `daemon_version`, sends `hello_ack`, and re-offers every queued run of agents assigned to the machine (`relay-core.ts:244-263`, `machines.ts:811-836`, up to 200 per hello).
- Feature flags travel in the hello `features` (kept on the socket, gates `library_changed`) and again per claim in the `X-Daemon-Features` header (gates claim fields) (`machine.ts:20-46`, `machine-runs.ts:100-122`).
- Separate from the WS ping, each run has an HTTP heartbeat (`POST .../heartbeat`, every 20 s from `apps/daemon/src/executor.ts:133`) against a 90 s run lease (`packages/services/src/runs.ts:111`).

Computer:
- Heartbeat: bare `ping` every 10 s (`HEARTBEAT_INTERVAL_MS`), stale after 25 s (`STALE_AFTER_MS`) (`computer.ts:16-18`). The platform answers `pong` and records the time (`relay.ts:75-76, 119-124`).
- The presence alarm runs every 60 s (`computer-relay-core.ts:61`). It closes a stale socket with 4408 and marks the computer offline, else refreshes `computer_last_seen_at` and re-marks online (`computer-relay-core.ts:936-964`). Pending requests also poll staleness every 2 s (`computer.ts:20`, `computer-relay-core.ts:586`).
- Capabilities come from the hello and are stored as `computer_capabilities {arch, clientVersion, desktop, os, workdir}` (`machines.ts:666-679`). `python3`, `git`, `skills` and `desktop_unavailable_reason` stay in the DO's stored hello (`computer-relay-core.ts:70, 838-842`) and are not written to D1.
- Desktop availability: desktop ops are refused with `desktop_unavailable` unless the last hello said `capabilities.desktop === true` (`computer-relay-core.ts:774-775`), with `desktop_unavailable_reason` in the message (`:558`). The UI labels a computer "Desktop" or "Headless" from `computerCapabilities.desktop` (`machine-logic.ts:46-55`).
- Desktop lease: idle agent hold 10 min, human hold 5 min (`computer-relay-core.ts:76-77`). Exec timeout default 30 s, max 600 s (`:63-65`).

Shared:
- One DO per machine and one identity key (`relay-core.ts:38`). Revoke closes every socket of the machine with 4401 (`relay.ts:186-196`, `machine-relay-core.ts:190-194`).
- A new connection for a role replaces only that role's old socket: 1012 for the daemon (`relay-core.ts:198-218`), 4409 for the computer (`computer-relay-core.ts:804-821`).
- A Rust client running both roles needs two sockets with two heartbeat styles and two sets of close-code handling. 4401 is terminal on both.
