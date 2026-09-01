# computerd

The daemon behind an Agentum agent's computer when that computer does not live
in a Cloudflare Durable Object. It serves the five computer operations - `read`,
`write`, `edit`, `list`, `exec` - over one JSON protocol, and can be reached two
ways:

- **connect mode** (self-hosted): the container dials out to Agentum over a
  WebSocket and answers requests that arrive on it. No inbound port, no tunnel,
  no public IP - it works on a laptop behind NAT.
- **listen mode** (Fly.io): the container answers HTTP on a port, and Agentum
  posts to it. This is what a Fly Machine runs.

Same image either way; `COMPUTERD_MODE` picks.

> **The container runs whatever the agent decides to run**, with the network
> access the container has. The container boundary is the safety. Give it its
> own volume, cap its memory and CPU, and put it on a machine and a network you
> are willing to hand to a program.

## Run it on your own hardware

Create the host in Agentum (Settings → Computer hosts) to get a token, then:

```sh
docker run -d --name agentum-computer \
  --restart unless-stopped \
  --memory 2g --cpus 2 \
  -v agentum-computer:/home/agent \
  -e AGENTUM_URL=https://agentum.rockyshoreslabs.io \
  -e AGENTUM_COMPUTER_TOKEN=<token> \
  ghcr.io/codewithpassion/agentum-computerd
```

Podman is the same command with `podman run`, plus one flag:

```sh
podman run -d --name agentum-computer \
  --restart unless-stopped \
  --memory 2g --cpus 2 \
  --userns=keep-id \
  -v agentum-computer:/home/agent \
  -e AGENTUM_URL=https://agentum.rockyshoreslabs.io \
  -e AGENTUM_COMPUTER_TOKEN=<token> \
  ghcr.io/codewithpassion/agentum-computerd
```

`--userns=keep-id` maps the container's `agent` (uid 1000) to your own user, so
files in the volume stay readable from the host under rootless Podman. Without
it the volume ends up owned by a subordinate uid.

The named volume is the computer: everything under `/home/agent` survives
`docker rm` and a new image, and everything outside it does not - including
packages an agent installs with `apt`.

`docker logs agentum-computer` shows connects, disconnects and reconnect
backoff. The daemon reconnects forever, so stopping Agentum or losing the
network is a pause, not a failure. Rotating the host's token disconnects the
container until it is restarted with the new one.

## Run it in listen mode

```sh
docker run -d --name computerd \
  -p 8080:8080 \
  -v agentum-computer:/home/agent \
  -e COMPUTERD_MODE=listen \
  -e COMPUTERD_TOKEN_HASH=<sha-256 hex of the token> \
  ghcr.io/codewithpassion/agentum-computerd
```

The daemon never holds the plaintext token here: it is given the hash and
compares what each caller presents against it.

- `GET /healthz` → `200 {"ok": true, "version": "..."}`, no auth. This is the
  liveness probe.
- `POST /op` → the JSON protocol below. `Authorization: Bearer <token>` is
  required; a wrong or missing token is `401`. Everything else answers `200`
  with `{ id, result }`, failures included, so a caller parses one shape.

## Environment

| Variable                 | Mode    | Default       | Meaning                                                      |
| ------------------------ | ------- | ------------- | ------------------------------------------------------------ |
| `COMPUTERD_MODE`         | both    | `listen`      | `listen` or `connect`. The image defaults to `connect`.       |
| `COMPUTERD_ROOT`         | both    | `/home/agent` | The computer's root; created at startup if it is not there.   |
| `COMPUTERD_MAX_EXEC_MS`  | both    | `600000`      | Ceiling on one `exec`, whatever the request asks for.         |
| `COMPUTERD_PORT`         | listen  | `8080`        | Port to serve on.                                             |
| `COMPUTERD_TOKEN_HASH`   | listen  | required      | SHA-256 hex of the token callers must present.                |
| `AGENTUM_URL`            | connect | required      | Agentum's base URL; the socket URL is derived from it.        |
| `AGENTUM_COMPUTER_TOKEN` | connect | required      | The host token, presented once at connect time.               |

## Protocol

One JSON object per request, one per response, identical over HTTP and over the
WebSocket:

```
{ id, op: "read",  path, maxBytes? }             -> { ok, content, size }    | { ok: false, reason }
{ id, op: "write", path, content, encoding? }    -> { ok, created, size }    | { ok: false, reason }
{ id, op: "edit",  path, oldString, newString }  -> { ok, created, size }    | { ok: false, reason }
{ id, op: "list",  path }                        -> { ok, entries }          | { ok: false, reason }
{ id, op: "exec",  command, timeoutMs?, cwd? }   -> { ok, exitCode, stdout, stderr } | { ok: false, reason }
{ id, op: "ping" }                               -> { ok, version, hostname, uptimeMs }
```

Responses are `{ id, result }`, echoing the request's `id`. An unknown op or a
malformed request is `{ ok: false, reason }` - nothing throws and nothing 500s.

**Paths are absolute inside the root.** `/notes/plan.md` means
`${COMPUTERD_ROOT}/notes/plan.md`, which is the same namespace the Cloudflare
backend exposes, so an agent's files look identical on every backend. A path
that is relative, that contains `..`, or that resolves outside the root through
a symlink is refused.

**`exec`** runs `sh -c <command>` as `agent`, in the root unless `cwd` says
otherwise (and `cwd` must also be inside the root). The command gets its own
session, so the deadline kills the whole process group rather than just the
shell; a timeout reports `exitCode: 124` and a note on stderr, the way
`timeout(1)` does. `timeoutMs` defaults to 30 000 and is capped at
`COMPUTERD_MAX_EXEC_MS`. Each stream is truncated to 16 000 bytes with a note
saying what was dropped. One command runs at a time; a second `exec` waits.

`write` takes `encoding: "base64"` for binary content; the default is utf8.

## Development

```sh
bun test          # handlers, exec, both transports
bun run typecheck
bun run src/main.ts
docker build -t agentum-computerd:dev .
```

The daemon has no runtime dependencies - the image is Debian, Bun and `src/`.
