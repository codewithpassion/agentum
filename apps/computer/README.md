# Agentum computer client

`hm-computer` connects a machine to Agentum over an outbound WebSocket.
It runs shell commands, transfers files, and optionally provides a Linux virtual
desktop. It needs no inbound port. Commands run as the user running the client.

## Build and enroll

From the repository root:

```sh
bun run --cwd apps/computer build:local
apps/computer/bin/hm-computer enroll --url https://agentum.example.com --code hm_enr_YOUR_CODE
apps/computer/bin/hm-computer run
apps/computer/bin/hm-computer status --json
```

Use a single-use `hm_enr_` code issued by Agentum. The CLI retains the
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

## Docker

Two images carry the daemon. `harbourmaster-computer` is headless: the daemon on busybox, for
commands and files. `harbourmaster-computer-desktop` adds Xvfb, Openbox, Chromium, xdotool and
xclip on display `:99`, for agents that drive a screen. Both run as uid 1000 and keep private
state in the `/var/lib/hm-computer` volume.

Issue a single-use `hm_enr_` code in Agentum, then enrol and run in one command. The
entrypoints end in `hm-computer run`, so `--url` and `--code` enrol the computer on first start. The
credential lands in the volume, and later starts ignore the spent code.

Headless:

```sh
docker run -d --restart unless-stopped --name hm-computer \
  -v hm-computer:/var/lib/hm-computer \
  ghcr.io/<owner>/harbourmaster-computer:latest \
  --url https://agentum.example.com --code hm_enr_YOUR_CODE
```

Desktop. Chromium keeps its sandbox, which the default Docker seccomp profile refuses, so pass
`packaging/desktop/seccomp.json` from this directory, which you can download from the repository. Without it the daemon still starts and
reports the desktop as unavailable.

```sh
docker run -d --restart unless-stopped --name hm-computer-desktop \
  --shm-size=256m --cap-drop ALL --cap-add SYS_CHROOT \
  --security-opt no-new-privileges \
  --security-opt seccomp=packaging/desktop/seccomp.json \
  -v hm-computer-desktop:/var/lib/hm-computer \
  ghcr.io/<owner>/harbourmaster-computer-desktop:latest \
  --url https://agentum.example.com --code hm_enr_YOUR_CODE
```

`--cap-add SYS_CHROOT` is required with `--cap-drop ALL`. Chromium's sandbox calls `chroot`, and the
profile in `packaging/desktop/seccomp.json` allows that call only for a container that holds `CAP_SYS_CHROOT`.
Without it the self-test aborts and the daemon reports the desktop as unavailable.

To keep the code off the `docker run` command line, pass `--env-file` with `HM_URL` and `HM_ENROLL_CODE` instead of the two flags. Do not use `--code-stdin` in a detached container: it reads an empty stdin and exits on every start.
Pin a host to one build with the commit tag instead of `latest`. Podman should work the same but
is untested.

To build locally, run `bun run docker:build` or `bun run docker:build:desktop` in this
directory, and use `hm-computer:local` or `hm-computer-desktop:local` in place of the ghcr names.
`bun run test:desktop-image` builds the desktop image and runs its integration checks inside it,
once with the seccomp profile and once with Docker's default.

Publishing: the `computer images` workflow (`.github/workflows/computer.yml`) builds both images
and pushes them to `ghcr.io/<owner>/harbourmaster-computer` and `-desktop`, tagged `latest` and
the commit. It starts only by hand (`workflow_dispatch`). After the first run, set each package's
visibility to public on GitHub so `docker pull` works without a login.

## Host service

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
