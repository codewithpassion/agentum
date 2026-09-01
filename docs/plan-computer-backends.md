# Computer backends: Fly.io and self-hosted — implementation plan

## Goal

An agent's computer (the files and shell behind `computer_*`) can run somewhere
other than the Cloudflare Durable Object it lives in today:

- on **Fly.io**, as a Fly Machine per agent that Agentum creates, starts and
  stops on demand;
- on **your own hardware**, as a Docker or Podman container you start yourself,
  which connects out to Agentum and needs no inbound port, tunnel or public IP.

Both give an agent a real Linux shell in production, which the Cloudflare
backend cannot (the Worker Loader is dev-only). The choice is per agent, made
when the agent is created, like its runtime. The agent, the tools, the Files
tab and the activity feed do not know or care which backend they are on.

Out of scope: moving the agent *loop* off Cloudflare (that stays in the
`AgentRouter`/`AgentRunner` DOs on both runtimes), and the browser (stays on
Browser Run). Managed-runtime agents keep Anthropic's sandbox as well; this
computer is the one both runtimes reach through the `computer_*` tools.

## The shape in one paragraph

One small program, **`computerd`**, shipped as one container image. It serves
the five computer operations (`read`, `write`, `edit`, `list`, `exec`) over a
plain JSON protocol and can be reached two ways: **listen** mode, where it
answers HTTP on a port (Fly), and **connect** mode, where it dials a WebSocket
out to Agentum and answers requests that arrive over it (self-hosted). Agentum
gets a second implementation of `AgentComputerClient` that speaks that
protocol, plus one Durable Object that holds the outbound connections. Fly is
"listen mode plus the Machines API to manage the machine's lifecycle";
self-hosted is "connect mode plus a pairing token". Everything above the
client - tools, routes, activity log, path rules, size caps - is untouched,
because it already only sees the interface.

## Locked design decisions

1. **Backend selection is per agent, fixed at creation**, exactly like
   `runtime`: `agents.computer` text not null default `"cloudflare"`, one of
   `cloudflare | fly | self_hosted`, plus `agents.computer_host_id` (nullable)
   pointing at the host row (§3) for the two remote kinds. Fixed because a
   computer's files live in the backend; moving them is a migration, not a
   toggle. `createComputerClient(db, env, agentId)` becomes the dispatcher: it
   loads the agent and returns the DO client (today's code, unchanged) or the
   remote client (§4). Tools and routes keep calling it exactly as now.

2. **`computerd` is its own package** (`apps/computerd`, Bun, single
   `Dockerfile`, published to GHCR as `ghcr.io/<org>/agentum-computerd`),
   because it is what users run on their hardware and it must not drag the web
   app's dependencies along. Same image for Fly and self-hosted; the mode is a
   flag.

   Protocol: JSON request/response, one object per call, identical over HTTP
   and over the WebSocket:

   ```
   { id, op: "read",  path, maxBytes }              -> ReadResult
   { id, op: "write", path, content }               -> WriteResult   (content: utf8 string, or base64 with encoding: "base64")
   { id, op: "edit",  path, oldString, newString }  -> WriteResult
   { id, op: "list",  path }                        -> ListResult
   { id, op: "exec",  command, timeoutMs, cwd? }    -> ExecResult
   { id, op: "ping" }                               -> { ok: true, version, hostname, uptime }
   ```

   The result types are the ones in `modules/computer/types.ts`, verbatim, so
   the client does no translation. Paths are absolute inside the computer's
   root (`/home/agent`, mounted from the volume); `validatePath` in the client
   still runs first, so the daemon never sees `..` or a relative path, and it
   refuses them anyway.

   `exec` runs `sh -c <command>` as the unprivileged `agent` user with the root
   as cwd, captures stdout/stderr up to `TOOL_OUTPUT_MAX_BYTES` each (the
   daemon truncates too, so a runaway command cannot flood the socket), kills
   the process group at `timeoutMs`, and reports the exit code. Default
   timeout stays `EXEC_TIMEOUT_MS` (30 s); remote backends allow the tool to
   ask up to 10 minutes, because "run the test suite" is the point of a real
   shell.

   The image is Debian slim with the tools an agent expects: `bash`,
   `coreutils`, `curl`, `git`, `jq`, `python3`, `node`/`bun`, `sqlite3`,
   `ripgrep`. `apt` is present, so an agent can install more; whether that
   persists depends on the volume (it does not, unless it lands under
   `/home/agent`). Users on their own hardware can build a derived image with
   whatever else they want.

   Auth on every request: `Authorization: Bearer <token>` in listen mode, the
   same token once at connect time in connect mode. Tokens are per host (§3).
   The daemon side is the same in both modes - it holds the hash and checks
   presented tokens with `timingSafeEqual` - but who holds the plaintext
   differs, and §3 stores it accordingly.

3. **A `computer_hosts` table** (`modules/computer/schema.ts`, plain
   `workspace_id`, no FKs), one row per Fly app or per self-hosted machine:

   - `id`, `workspace_id`, `name`, `kind` (`fly | self_hosted`)
   - the daemon's credential, stored by which side presents it:
     - `self_hosted`: `token_hash` text unique. The token flows *inbound* -
       the daemon holds the plaintext and dials in, Agentum verifies against
       the hash - so it is issued once at creation and shown once, the MCP
       token pattern.
     - `fly`: `token_enc` text, `encryptSecret` under `CONNECTOR_KEY`. Here
       the direction flips - Agentum is the client presenting the token to
       computerd on every request - so Agentum must hold the plaintext.
       Agentum generates it, encrypts it, and injects its *hash* into the
       machine's env at create time; the user never sees it and there is no
       "shown once" step for Fly hosts.
   - `config` json — Fly: `{ app, region, image, instance: { cpus, memory_mb }, volume_gb }`;
     self-hosted: `{}`
   - `fly_api_token_enc` — Fly only, `encryptSecret` under `CONNECTOR_KEY`,
     write-only, hint column like the Anthropic key
   - `status` (`unconfigured | ready | error | offline`), `status_error`,
     `last_seen_at` (connect mode: last heartbeat; listen mode: last successful
     ping), timestamps

   A self-hosted host is one container; one agent per host. If two agents
   should share a box, the user runs two containers with two tokens - simpler
   than multiplexing agents inside one daemon, and it keeps each agent's files
   in its own volume. A Fly host is one Fly *app*; agents on it each get their
   own machine and volume, recorded on the agent: `agents.computer_ref` json
   (`{ machineId, volumeId }` for Fly; null for self-hosted).

4. **The remote client** (`modules/computer/remote-client.ts`) implements the
   same five methods by sending protocol messages through a `Transport`:

   - **HTTP transport** (Fly): `POST https://<app>.fly.dev/op` with the bearer
     token and `fly-force-instance-id: <machineId>`, so the Fly proxy routes to
     that agent's machine and auto-starts it if stopped. Every request also
     bumps the machine's "in use" time for the idle stop (§5).
   - **Relay transport** (self-hosted): an RPC into the `ComputerRelay`
     Durable Object (§6), which forwards the message over the daemon's
     WebSocket and resolves with the reply.

   Failures map to `{ ok: false, reason }` with a reason a person can act on:
   "The computer host `office-box` is offline (last seen 12 minutes ago). Start
   the container and try again." - and never a stack trace. The activity log
   records the failure the way exec failures are recorded today.

5. **Fly backend** (`modules/computer/fly.ts`, behind a `FlyGateway` interface
   so the HTTP calls are fakeable, the way `AnthropicGateway` is):

   - The user provides a Fly API token (deploy token scoped to one app,
     created with `fly tokens create deploy -a <app>`) and an app name they
     created (`fly apps create`, with a shared IPv4/IPv6 allocated so
     `<app>.fly.dev` resolves). We do not create apps: it needs an org-scoped
     token and we do not want one.
   - Creating an agent on that host: create a volume (`POST /v1/apps/{app}/volumes`,
     `size_gb` from config, in the host's region), then a machine
     (`POST /v1/apps/{app}/machines`) with `config.image` = the computerd
     image, `mounts: [{ volume, path: "/home/agent" }]`, `env: { COMPUTERD_MODE: "listen", COMPUTERD_TOKEN_HASH: ... }`,
     `services: [{ protocol: "tcp", internal_port: 8080, ports: [{ port: 443, handlers: ["tls","http"] }], autostart: true, autostop: "stop" }]`,
     and `guest` from the instance config. Record `{ machineId, volumeId }` on
     the agent. Deleting the agent deletes the machine, then the volume.
   - Lifecycle: the Fly proxy starts a stopped machine on the first request
     and stops it when idle (the `autostop`/`autostart` service settings), so
     Agentum never has to call start/stop in the hot path. It does call
     `POST /machines/{id}/stop` when an agent is deleted or the host is
     removed. Cost is per second while running; the plan's default instance is
     `shared-cpu-1x` / 512 MB, configurable per host.
   - The token *the daemon checks* is the host token (§3): its hash goes into
     the machine's env at create time, and the plaintext is decrypted from
     `token_enc` for each request the HTTP transport makes. Rotating it
     re-encrypts a new one and updates every machine's config
     (`POST /machines/{id}` with the new env).
   - Health: `ping` on host creation and from a "Test connection" button;
     `status` is derived from that, plus machine state from
     `GET /machines/{id}` on the agent screen.

6. **Self-hosted backend, connect mode** (`modules/computer/relay.ts`, a
   `ComputerRelay` Durable Object, `idFromName(hostId)`):

   - The daemon dials `wss://<app>/api/computer-hosts/connect` with its token.
     The route hashes it, finds the host row (globally, like `/mcp/:token`),
     and hands the socket to that host's relay DO, which accepts it with the
     WebSocket **hibernation API** (`ctx.acceptWebSocket`) so an idle
     connection costs nothing and survives the DO being evicted. The daemon
     reconnects with backoff whenever the socket drops; the relay marks the
     host `offline` after a missed heartbeat window and `ready` on connect
     (writing `last_seen_at` to D1).
   - A request from the client is `relay.request(message)`: the DO writes the
     JSON to the socket, keeps a pending map `id → resolver` in memory (a
     hibernated DO loses it, which is fine: it was idle, so nothing was
     pending), and resolves when the matching reply arrives in
     `webSocketMessage`. A request that finds no socket returns the offline
     reason from §4 without waiting. One in-flight exec per host at a time;
     a second exec queues behind it, matching how the DO computer behaves.
   - Large payloads (a 500 KB file write, a 16 KB stdout) fit in WebSocket
     messages comfortably; nothing here needs streaming in v1.
   - Pairing UX: the host row is created in the UI, which shows the one-time
     token inside a ready-to-paste command:

     ```
     docker run -d --name agentum-computer \
       -v agentum-computer:/home/agent \
       -e AGENTUM_URL=https://agentum.rockyshoreslabs.io \
       -e AGENTUM_COMPUTER_TOKEN=<token> \
       ghcr.io/<org>/agentum-computerd
     ```

     with a Podman variant (`podman run` is identical; note `--userns=keep-id`
     for rootless volume ownership). The host page shows connected/offline
     and last seen, and the token can be rotated (which disconnects the
     daemon until it is restarted with the new one).
   - Security stance, stated on the host page: **the container runs whatever
     an agent decides to run, with the network access the container has**.
     Mitigations we ship: unprivileged user, no capabilities, read-only
     rootfs except `/home/agent` and `/tmp`, a `--memory`/`--cpus` line in the
     suggested command. Mitigations the user owns: which machine, which
     network, whether to add `--network` restrictions or an egress proxy.
     Secrets: the workspace-secrets plan's outbound-injection hook (§6 there)
     applies to `computerd` too - a small egress proxy in the container that
     swaps placeholders for the host's allowlisted hosts - and is deferred with
     it.

7. **Cloudflare backend stays the default** and is unchanged. Its production
   limitation (no shell) is documented on the agent dialog next to the picker,
   which is what motivates the other two.

8. **System prompt**: the computer intro in the tools already describes a
   private, persistent filesystem plus a "small POSIX shell". For agents on a
   remote backend the `computer_exec` description says instead: "a real Linux
   shell (Debian) with bash, git, curl, python3, node and package managers;
   commands may run up to 10 minutes; files under /home/agent persist." Set
   per agent from the backend at tool registration, the way tools already
   close over `ctx.agent`.

## API contract (mounted under `workspaceScopedRoutes` at `/computer-hosts`)

Owner-gated writes (`requireOwner`), members may list.

- `GET /computer-hosts` → `{ hosts: HostView[] }`,
  `HostView = { id, name, kind, status, statusError, lastSeenAt, config (no token, no Fly token; Fly token hint only), agentIds, createdAt }`.
- `POST /computer-hosts` — `{ name, kind, config, flyApiToken? }`. For `fly`,
  validates the token against `GET /v1/apps/{app}` before storing (fail closed,
  generic message). Returns `{ host: HostView, token }` — the daemon token,
  shown once. 201.
- `PATCH /computer-hosts/:id` — `{ name?, config?, flyApiToken?, rotateToken?: true }`.
  Rotation returns a fresh `token` once, like `rotateMcpToken`.
- `DELETE /computer-hosts/:id` — refused (409) while any agent uses it; the
  agents must be deleted or (Fly) their machines destroyed first.
- `POST /computer-hosts/:id/test` → `{ ok, version?, hostname?, reason? }` — a
  `ping` through the real transport.
- `GET /api/computer-hosts/connect` (outside `requireAuth`, like `/mcp`): the
  daemon's WebSocket upgrade, token in `Authorization`.

Agents API: `POST /agents` accepts `computer` and `computerHostId`; the pair is
validated (host must be in the workspace and of the matching kind; a
self-hosted host takes one agent). Both immutable on `PATCH`, same error as
`runtime`.

`computerd` (`apps/computerd`): `GET /healthz`, `POST /op` (listen mode), and
the connect loop. Config from env: `COMPUTERD_MODE`, `COMPUTERD_TOKEN_HASH`
(listen) or `AGENTUM_URL` + `AGENTUM_COMPUTER_TOKEN` (connect),
`COMPUTERD_ROOT` (default `/home/agent`), `COMPUTERD_MAX_EXEC_MS`.

## UI

- **Settings → Computer hosts** (owner): list with kind, status dot, last
  seen; "Add host" with a Fly form (app, region, token, instance size, volume
  GB) or a self-hosted form (name only), followed by the one-time token screen
  with the copyable `docker run` / `podman run` command; per-host page with
  Test connection, rotate token, remove.
- **Agent dialog** (create only): "Computer" select — Cloudflare (default,
  "files only in production"), Fly.io host…, Self-hosted host… — with a second
  select for the host when one of the remote kinds is chosen. Shown read-only
  on edit, like runtime.
- **Agent screen**: the Files tab and activity feed work unchanged; the header
  shows where the computer runs and, for Fly, the machine state
  (started/stopped) from the host status.

## Phase-entry spikes (before building, in `scripts/`)

1. **Fly**: with a deploy token, create a volume and a machine from a public
   image with a service on 443, hit it via `<app>.fly.dev` with
   `fly-force-instance-id`, confirm auto-start from stopped (measure the cold
   start), auto-stop after idle, and that a second machine in the same app is
   reachable the same way. This pins every payload `fly.ts` sends.
2. **Relay**: a throwaway Worker with a hibernating-WebSocket DO and a
   20-line Bun client, to confirm request/response over a hibernated socket
   and the reconnect behaviour when the DO is evicted mid-connection.
3. **Image**: build `computerd` and run it under both Docker and rootless
   Podman with a named volume; confirm file ownership across restarts.

## Work split

- **Forge 1 — `computerd`** (first; the other tracks test against it): the
  package, protocol handlers, exec with timeout and truncation, both modes,
  Dockerfile, GHCR publish workflow, unit tests for the handlers.
- **Forge 2 — data model + dispatcher** (after 1's protocol is fixed):
  `computer_hosts` schema + migration, `agents.computer`/`computer_host_id`/
  `computer_ref` (one migration), host service and routes, the
  `createComputerClient` dispatcher, `remote-client.ts` with a fake transport
  in tests, agent create/patch validation, tool description variant.
- **Forge 3 — Fly** (after 2, parallel with 4): `FlyGateway` + `fly.ts`,
  machine/volume lifecycle on agent create/delete, HTTP transport, test
  button, tests against a fake gateway.
- **Forge 4 — self-hosted relay** (after 2, parallel with 3): `ComputerRelay`
  DO + wrangler binding/migration, connect route, relay transport, heartbeat
  and status, tests with a fake WebSocket (the router-test harness pattern).
- **Forge 5 — frontend** (after 2): settings pages, agent dialog picker,
  agent screen header, `api.ts` types.

Spike 1 gates Forge 3: `fly-force-instance-id` is documented, but community
threads report it misrouting, and the plan's Fly transport depends on it.

Verification: unit suites per track; `bun x ultracite check`, `bun run
typecheck`, `bun run db:migrate:local`. Acceptance on the dev server:

- **Self-hosted**: `podman run` the image on this machine against the dev
  server (connect mode reaches `localhost:3720` from a container via
  `host.containers.internal`), create an agent on it, ask it to
  `git clone` a public repo and run its tests, watch the exec rows arrive in
  the activity feed, stop the container mid-task and confirm the agent gets
  the offline reason rather than a hang, restart it and confirm the files are
  still there.
- **Fly**: the same task on a Fly host; confirm the machine shows stopped a
  few minutes after the agent goes idle and starts again on the next command.
- **Managed runtime**: one multi-minute `exec` from a managed agent on either
  remote backend, to settle the MCP-timeout risk below before the 10-minute
  cap is advertised to those agents.

## Risks

- **Fly cold start on the first command after idle** (a few seconds) lands
  inside a tool call; fine for the tool, but the first `exec` after a long
  idle will feel slow. Spike 1 measures it; if it is over ~10 s, Agentum can
  pre-start the machine when the agent wakes (`POST /machines/{id}/start`
  from the router) rather than on the first tool call.
- **`fly-force-instance-id` does not work for WebSockets**, only HTTP. The
  Fly transport is plain HTTP by design; do not "upgrade" it to a socket later
  without a different routing story (one app per agent, or the Machines
  `exec` endpoint).
- **A self-hosted host is a trusted machine by definition.** Nothing in
  Agentum can make an agent's `rm -rf` on your box safe; the container
  boundary is the safety, and the suggested run command is where we put the
  guard rails. Say so in the UI, not only in this plan.
- **Idle relay and hibernation**: an exec that outlives the DO's in-memory
  pending map (an eviction while a 10-minute command runs) loses the reply.
  The client's timeout turns that into a clear failure, and the daemon's
  activity is still on disk; acceptable for v1, and spike 2 tells us how
  often it happens in practice.
- **A long exec on the managed runtime rides inside one MCP tool call**: the
  HTTP request Anthropic makes to `/mcp/:token` stays open for the whole
  command (Anthropic → Worker → Fly or relay → back). The Cloudflare runtime
  is fine - the call is in-process inside the runner's alarm - but Anthropic's
  MCP client timeout on a held-open request is unverified. Acceptance must run
  a multi-minute command through a *managed* agent as well; if it times out,
  cap `timeoutMs` lower for managed agents and say so in the tool description.
- **Two more moving parts to operate**: a container registry and, for Fly,
  the user's own app and billing. Both are opt-in per agent, and the
  Cloudflare default keeps working with no setup.
