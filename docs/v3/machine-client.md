# One machine client, in Rust

Status: decided by Dom on 5 Nov 2026. Milestone RC, tasks RC.1 to RC.7.

## Why

A machine reaches Agentum through two clients today. `apps/daemon` is TypeScript compiled with Bun into a 95 MB `agentum` binary and serves the `agent_host` role. `apps/computer` is Go, ported from the old agentum repo, and ships `hm-computer` for the `computer` role. They differ in enrolment, state, heartbeat, backoff, exit codes and service install, and a machine with both roles needs two codes, two credentials and two processes. One Rust binary replaces both.

The inventory of everything the two clients do, with file references, is in `docs/v3/machine-client/` (`inventory.md` is the summary; `daemon.md`, `computer.md` and `server.md` hold the detail). It is the parity checklist: anything listed there that this spec doesn't drop must work in the new client.

## Decisions (Dom, 5 Nov 2026)

1. **One binary, named `agentum`, written in Rust**, with all the functionality of both clients.
2. **No bundled TypeScript.** The client drives the `claude` CLI itself over its stream-json protocol, the way the Agent SDK does (inventory section 3).
3. **One enrolment for both roles.** One code, one credential, chosen roles. Server change in RC.1.
4. **The machine name comes from the server** in the enrol answer, and `--name` overrides it. It names the instance.
5. **Several instances on one machine** never collide.
6. **Who agents run as is chosen at install**: the current user, a named user, or a per-instance agent user.
7. **It installs itself as a service**, as a system service or a user service with lingering.
8. **A helpful CLI for people**, above all when a permission is missing.
9. **Linux on x64 and arm64 first.** macOS later; the Go client stays available on macOS until then.
10. **Old clients keep working** until the machines have moved; then `apps/daemon` and `apps/computer` are retired in a later task.

## Layout

- `apps/agentum/`: a Cargo project (edition 2024, stable toolchain), with a `package.json` whose `check` and `test` scripts run `cargo fmt --check`, `cargo clippy -- -D warnings` and `cargo test`, and skip with a message when `cargo` is missing, as `apps/computer` does for Go.
- One crate is fine to start; split modules by area: `cli`, `instance` (names, paths, config), `enroll`, `relay` (agent_host socket), `computer` (computer socket and commands), `desktop`, `runs` (claim, events, heartbeat, complete, requests), `claude` (the CLI driver), `approvals`, `files`, `library` (sync), `service`, `privilege` (every privileged operation and its explanation), `doctor`.
- Async runtime tokio; HTTP and WebSocket with rustls (no OpenSSL), so the binary is static with musl.
- Wire types are serde structs tested against the existing fixtures: `packages/protocol/fixtures/`, `apps/computer/testdata/protocol/`, `apps/computer/testdata/enroll/` and `apps/daemon/fixtures/tool-run/`. Ignore unknown fields in everything the client reads. Everything the client sends matches the strict server schemas key for key, checked against the fixtures: an extra key in `hello` means no ack and an endless reconnect.

## Instances, names and paths

An instance is one enrolment. Its name is the machine name from the server, made into a slug (`[a-z0-9-]`, at most 40 characters), or `--name`. Enrol checks `--name` for a clash before calling the server. A server name that clashes gets `-2`, `-3` and so on, and enrol prints the name it chose. A credential the server issued is never thrown away. An instance has the roles from the enrol answer; adding a role means enrolling again with a new code.

| | user service | system service |
|---|---|---|
| config and credential | `$XDG_CONFIG_HOME/agentum/<instance>/` (default `~/.config/agentum/<instance>/`), 0700; `config.json` and `credential` 0600 | `/etc/agentum/<instance>/` 0700 root, same files |
| state and work dirs | `$XDG_STATE_HOME/agentum/<instance>/` | `/var/lib/agentum/<instance>/` |
| unit | `~/.config/systemd/user/agentum-<instance>.service` | `/etc/systemd/system/agentum-<instance>.service` |
| desktop display | the lowest free `:N` from 90 up, recorded in config | same |

Every command takes `--instance <name>`. With exactly one instance it is optional. With several and none given, the command lists them and asks for one. `agentum list` shows every instance with its roles, service state and connection state.

The credential sits in its own file, never in `config.json`, never in argv after enrol, never in a log line.

## Commands

- `agentum enroll --code <code> --url <server> [--name <name>] [--system] [--run-as current|<user>|agent-user] [--code-stdin] [--json]`. `--url` is required (the install script passes it). The roles come from the code. The code may also come from `AGENTUM_ENROLL_CODE`, which the client unsets after use. `--json` prints `{instance, machineId, roles}` for the install script. The old spellings are not needed: old install scripts download the old product and never call this binary.
- `agentum run [--instance <name>] [computer flags]`: runs the instance in the foreground, opening one socket per role. For Docker, `run --url --code [--code-stdin]` enrols on first start, as `hm-computer run --code` does. The service unit runs `agentum run --instance <name>`.
- `agentum service install [--user | --system] [--run-as current|<user>|agent-user] [--claude <path>] [--desktop]`, `service uninstall`, `service status`, `service logs [-f]`, `service restart`. `install-service` stays as an alias.
- `agentum status [--json]`, `agentum list [--json]`.
- `agentum doctor`: runs every check below and prints each as ok, warning or problem with the fix.
- `agentum version`, `--version`, `-v`. The version string keeps today's format, `<version>+<short sha>`, because the server's update hint compares it exactly.
- `agentum help` and `--help` on every command, with an example.

Exit codes, for both roles: 0 ok or stopped by a signal, 1 runtime failure, 2 usage error, 3 the server rejected the credential (enrol again), 4 not enrolled, 5 a permission or prerequisite is missing. The unit sets `RestartPreventExitStatus=3 4 5`, so a revoked or broken instance doesn't restart every few seconds.

## Who agents run as

- `current` (the default for a user service): agents run as the user running the service, with that user's own `claude`, login and settings. No sudo.
- `<user>`: a named existing user. The service runs as that user (system service with `User=`). Needs root to install.
- `agent-user` (system service only): a per-instance user `agentum-<instance>`, created at install with its own home and work tree, with today's sudoers rule narrowed to that user. This is today's `hm-agent` mode, made per instance.

`service install` prints what the choice means in one or two plain sentences, for example: "Agents will run as dom. They can read and change anything dom can, including ~/.ssh. Use --run-as agent-user on a system service to keep them apart." It asks for confirmation on a terminal, and `--yes` skips it.

## The agent_host role

Parity with `apps/daemon`, listed in inventory sections 1.5 to 1.9 and 1.13: the relay socket and frames, hello with features, offer, cancel, library_changed, one run per agent with a queue, the run routes with their timeouts, seq numbers, batching, lease heartbeat, complete states, requests and long-poll, approvals, files, skills, library sync, task folder, env filtering, and the `X-Daemon-Features` header. Keep the heartbeat, backoff and close-code handling this role has today (section 1.5), since the server's liveness rules are tuned to them.

### Driving claude

Spawn `claude` with the flags the SDK 0.2.119 uses (inventory 3.2), `--input-format stream-json --output-format stream-json`, and speak the control protocol:

- send `initialize` with the PreToolUse hook registration and the appended system prompt;
- `mcp_set_servers` with the claim's http MCP servers;
- answer `can_use_tool` and `hook_callback` exactly as the daemon does today;
- read the message types the daemon reads (section 3.1) and turn them into the same events the server gets today. `apps/daemon/fixtures/tool-run/` is the golden input and output.

Guard rails: a minimum `claude` version, checked at start and by `doctor`, with the install hint; an unknown control request is answered with an error and logged, never ignored; a conformance test that runs the real `claude` when it is installed (skipped otherwise) and checks one tool call end to end against a local fake server.

## The computer role

Parity with `apps/computer`, inventory sections 1.10 and 1.11 and `computer.md`: the computer socket and protocol v1 frames (frozen, byte for byte with the fixtures), shell commands with the policy flags (`--read-only`, `--workdir-only`, allow and deny lists, env allow list, limits), file transfer with its chunk sizes, the audit log with rotation, and the desktop (Xvfb, the window manager, screenshots, input) on Linux. Keep this role's heartbeat, pong and backoff as they are today. `--allow-root` stays: refuse to run as root without it.

## Permissions and help

Every privileged or environment-dependent step goes through the `privilege` module, which on failure returns what was tried, why it failed, what it means, and the exact command that fixes it. The CLI prints that, never a bare OS error. Cover at least:

- no systemd, or no user session bus (`systemctl --user` fails over SSH without a session): say so and show `loginctl enable-linger <user>` and the `XDG_RUNTIME_DIR` fix;
- linger off: offer to enable it (`loginctl enable-linger` works for your own user on most systems), and say what happens without it;
- not root for a system service or `agent-user`: show the `sudo agentum service install --system ...` line;
- the agent user can't run `claude` (a binary in a private home): today's message from `install-service.ts`, kept;
- `claude` missing, too old, or not logged in for the run-as user;
- desktop packages missing (Xvfb, the window manager, xdotool, xclip, a browser): the `apt` and `dnf` lines;
- config dir owned by another user, or with loose modes;
- the server unreachable, a TLS failure, a plain `http://` URL that isn't loopback, a redirect;
- the credential rejected (exit 3): "This machine was revoked or its credential replaced. Enrol it again with a new code from the Machines page."

`doctor` runs all of these without changing anything.

## Server changes (RC.1)

Inventory `server.md` section 2, option B:

- The enrol request takes `roles: ["agent_host", "computer"]` (one or both) with the computer fields and `singleUser`, as a new body kind. Old bodies work unchanged.
- One code can cover both roles. `createEnrollToken` and the enrol dialog get a choice of roles.
- For the new body, `enroll` writes one credential hash to both places in one `atomic` write and sets `computer_status`. `authenticate` opens both roles with it.
- The answer to the new body adds `machineName` and `roles`. Old bodies get exactly today's answer, because deployed daemons parse it strictly. Nothing is added to `hello_ack`.
- The install script for the new client is `/install-agentum.sh`. `/install.sh` and `/install-computer.sh` stay for the old clients until they are retired.

## Release and install (RC.6)

- Build static musl binaries for `x86_64` and `aarch64` (cargo-zigbuild or `cross` through Docker), named `agentum-linux-x64` and `agentum-linux-arm64`, under a new release product `agentum-rs` so the old `agentum` daemon product keeps serving.
- `publish-releases.ts` publishes it the same way (R2, sha256 in `latest.json`, the same line format).
- `/install-agentum.sh` installs to `~/.local/bin/agentum` (or `/usr/local/bin` when root), enrols with the code, then runs `service install` with the right mode, printing what it did and what to run next.
- The Machines page offers the new command for new machines, with a role choice, and keeps the old commands behind "Older clients" until retirement.
- One Docker image `ghcr.io/codewithpassion/agentum` (headless and desktop variants), replacing `agentum-computer`.

## Tasks

- RC.1 server: one enrolment for both roles, the machine name in the answer.
- RC.2 Rust core: project, CLI, instances and paths, enrol, both sockets' connection loop, status, list, exit codes, the `privilege` module and `doctor` skeleton.
- RC.3 service install: user and system units, linger, run-as modes, per-instance agent user, uninstall.
- RC.4 agent_host role: runs, the claude driver, approvals, files, skills, library sync.
- RC.5 computer role: commands, policy, files, audit, desktop.
- RC.6 release, install script, Machines page, Docker image.
- RC.7 end to end on staging with a real machine, both roles, both service modes, two instances.

## Out of scope

macOS and Windows, auto-update, retiring the old clients (a later task once machines have moved), and changing any wire protocol beyond RC.1.

## Rules added after review (these win over anything above)

### Enrol, modes and paths
- Enrol takes `--system` and `--run-as`, and these set the paths and `singleUser` (false only for `agent-user`; the server uses it to withhold credentials, `credentials.ts`). The install script passes them. `service install` refuses a run-as that contradicts the stored `singleUser` and says to enrol again. Without a service (foreground or Docker) the user paths apply, and `AGENTUM_CONFIG_DIR` and `AGENTUM_STATE_DIR` override them. `HM_URL`, `HM_STATE_DIR` and `HM_ENROLL_CODE` are dropped; the Docker image uses the new names.
- System unit: `User=agentum-<instance>-svc` (created at install), or the named user for `--run-as <user>`. Config and state are owned by that user, 0700, via `ConfigurationDirectory=agentum/<instance>` and `StateDirectory=agentum/<instance>`. `agent-user` adds `agentum-<instance>`, reached through sudo from the service user. The unit must not set `NoNewPrivileges`, `ProtectHome` or `ProtectSystem`, because sudo and `~/.claude` need them off. Under sudo, `current` means `$SUDO_USER`.
- With `agent-user`, computer commands run as the agent user too. `service install` says that computer commands can read the credential, which also opens the agent_host role and `/mcp`.

### The RC.1 contract
- New enrol body: `{code, roles?, singleUser, arch, os, hostname, clientVersion}`, with Go names for `arch` and `os` (`amd64`, `arm64`, `linux`). The code carries the roles. A missing `roles` means "the code's roles"; a mismatch is a 400 with a message. The new body refuses codes bound to a `machineId` (the "add a role" codes).
- Answer: `{credential, machineId, machineName, roles}`.
- Fixtures `packages/protocol/fixtures/enroll-request-roles.json` and `enroll-response-roles.json`, written in RC.1 and used by RC.2. If RC.2 runs before RC.1 lands, RC.2 writes these two fixtures from this section and RC.1 keeps them byte for byte.

### When one role fails
- Close 4401 on either socket stops both and exits 3. 1012 and 4409 affect only their own socket. A missing prerequisite (for example `claude`) disables that role, logs why, and leaves the other running. Exit 5 only when no role can start, never for network errors.

### Computer run-time settings
- The policy flags, `--max-*`, `--audit-*`, `--workdir`, `--desktop`, `--desktop-display` and `--allow-root` are flags on `run` and `service install`, stored in a `computer` section of `config.json`.
- Logging: JSON lines to stderr by default (journald keeps them), `--log-format text` for a terminal. Keep the computer's audit log as it is.

### The claude driver's sources
- The daemon never writes control frames itself; the SDK does. The reference is `sdk.mjs` in `node_modules/@anthropic-ai/claude-agent-sdk` (version 0.2.119; run `bun install` in the worktree first). Port `apps/daemon/src/normalize.ts` and the cases in `executor.test.ts` one by one.
- Cover `control_cancel_request`, the 90000 s hook timeout and the `CLAUDE_CODE_ENTRYPOINT` env the SDK sets. Minimum claude version: 2.1.300.
- `fixtures/tool-run/events.json` is grouped into batches, so compare the events flattened.
- Port `toolKey`, `approvalSummary`, `outcomeText`, `askUserQuestionAnswers`, `workspaceInstructions`, `maxTurnsOf`, `stopMessage`, `taskFolderPath`, the masker and `@repo/library-sync`. Check each against JSON that a small bun script produces from the TypeScript originals (commit the script and its output as fixtures).
- The real-claude test runs only when `AGENTUM_CLAUDE_E2E=1`. This host has a logged-in claude, so a plain `bun run test` must not spend tokens.

### What RC.2 fixes before RC.3, RC.4 and RC.5 branch off
- The full `Cargo.toml` and `Cargo.lock` with every dependency the later tasks need (they don't add crates without a reason in their last message).
- The complete config schema, including the `computer` section and `run_as`.
- Every subcommand and flag parsed; stubs exit 1 with "not built yet".
- A `Role` trait (`hello`, `on_frame`, `shutdown`), with a socket generation so a reply never goes out on a newer socket.
- A `RunAs` enum, the work-root paths, and a doctor check registry with one file per module, so each later task adds checks in its own file.

### Release and install additions (RC.6)
- `install-agentum.sh` refuses when `~/.agentum/config.json` or `agentum.service` exists, unless `--replace-old` is given. That flag stops and disables the old unit and says to revoke the old machine on the Machines page.
- `isDaemonOutdated` and the update hint pick the product from `capabilities.agentSdk`: `claude-cli@…` means `agentum-rs`, with the hint `install-agentum.sh`.
- Under `curl | sh` there is no terminal, so print the run-as explanation without asking. Re-running the script replaces the binary and restarts each instance.
- Add a Rust toolchain to `.github/workflows/ci.yml`, or the `check` script just skips there.

### Small things
- A static musl binary can't see LDAP or SSSD users, so look users up with `getent passwd` as a fallback.
- Use `rustls-native-certs` so a corporate root CA works.
- `systemctl --user` fails under sudo, su or cron without a session bus; say that in the explanation, not "over SSH".
- RC.7 needs RC.1 deployed to staging first, and sudo on the test host for the system mode.
