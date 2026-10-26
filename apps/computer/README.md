# Harbourmaster computer client

`hm-computer` connects a machine to Harbourmaster over an outbound WebSocket.
It runs shell commands, transfers files, and optionally provides a Linux virtual
desktop. It needs no inbound port. Commands run as the user running the client.

## Build and enroll

From the repository root:

```sh
bun run --cwd apps/computer build:local
apps/computer/bin/hm-computer enroll --url https://harbourmaster.example.com --code hm_enr_YOUR_CODE
apps/computer/bin/hm-computer run
apps/computer/bin/hm-computer status --json
```

Use a single-use `hm_enr_` code issued by Harbourmaster. The CLI retains the
ported `--url` and `--code` flags (there is no positional code or `--server` flag).
To keep the code out of argv, use `--code-stdin` or `HM_ENROLL_CODE` instead.
`HM_URL` provides the server URL. HTTPS is required except on loopback for local
development, for example `http://127.0.0.1:8787`.

Enrollment posts exactly `{ arch, clientVersion, code, hostname, os, role: "computer" }`
to `/api/machines/enroll`, then reads `{ credential, machineId }`. Errors have
an `{ error: string }` body. The real computer enrollment route arrives in V6.9;
this port verifies the contract against an httptest server.

The default state directory is `~/.hm`, overridden by `HM_STATE_DIR` or
`--state-dir`. It is mode `0700`; `config.json` (server URL, machine ID and
options) and `credential` (the `hm_mach_` credential) are mode `0600`.
Keep this directory private. `run` dials `/api/machines/computer` with Bearer
authentication. A revoked credential exits with status 3; transient failures
reconnect with backoff. Protocol v1 frames and heartbeat literals stay frozen.

`run --url ... --code hm_enr_...` enrolls automatically when no credential exists.
Subsequent starts reuse the stored credential and ignore the spent code.
Use `--name` to override the hostname and `--desktop` to enable the virtual desktop.
Run `hm-computer help` for command options. Root requires `--allow-root`.
See `hm-computer run --help` for command and path policy flags.

## Containers and services

```sh
cd apps/computer
bun run docker:build
docker run -d --restart unless-stopped --name hm-computer \
  -e HM_URL=https://harbourmaster.example.com \
  -e HM_ENROLL_CODE=hm_enr_YOUR_CODE \
  -v hm-computer:/var/lib/hm-computer hm-computer:local
```

The image runs as uid 1000 and stores private state in the named volume.
Podman should work the same as Docker but is untested.

For a desktop image, run `bun run docker:build:desktop`. It contains Xvfb,
Openbox, Chromium and clipboard/input tools. Chromium retains its sandbox;
run with `--shm-size=256m --cap-drop ALL --security-opt no-new-privileges`
and `--security-opt seccomp=packaging/desktop/seccomp.json`.
The desktop is reported unavailable if the host cannot support it.
`bun run test:desktop-image` retains the source client's optional integration checks.

For a host service, install `packaging/hm-computer.service`, the binary at
`/usr/local/bin/hm-computer`, and an unprivileged `hm` user and group. Supply
`HM_URL` and the initial `HM_ENROLL_CODE` via `/etc/hm-computer.env` (mode `0600`).
The unit creates `/var/lib/hm-computer` privately. Remove the spent code after
enrollment. Enable and start the unit with `systemctl enable --now hm-computer`.

## Development

```sh
bun run test             # go test ./...
bun run test:race        # cgo-enabled race detector
bun run check           # vet, gofmt check, tests
bun run build:local     # bin/hm-computer
bun run build:release   # Linux/macOS amd64/arm64 plus SHA256SUMS
```

Scripts use host Go when available, otherwise Docker with `golang:1.23`.
They skip with a message only when both tools are absent. Docker caches modules
in `hm-computer-gopkg` and compiled packages in `hm-computer-gocache`.
`HM_GO_IMAGE`, `HM_GO_CACHE_VOLUME` and `HM_GO_BUILD_CACHE_VOLUME` override these.
Desktop tests skip when their X server/tools are unavailable.

Protocol tests read the existing shared `testdata/protocol/` fixtures without
rewriting their historical example strings. Enrollment fixtures live in
`testdata/enroll/`. The client derives from trueforge at `b3aded57`.
