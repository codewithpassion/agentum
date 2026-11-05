# Agentum Rust client core (RC.2)

From the repo root, use `bun run check` and `bun run test`. Rust checks also
run directly with `cargo test --manifest-path apps/agentum/Cargo.toml`.
`bun run --cwd apps/agentum build:release` writes `target/release/agentum`.
The Bun scripts skip with an explanation if Cargo is unavailable. CI installs
stable Rust, rustfmt and clippy. All Rust output is under `target/`.

```
agentum enroll --url https://agentumbot.io --code-stdin
agentum enroll --url https://agentumbot.io --code-stdin --name office
agentum list --json
agentum status --instance office
agentum doctor --instance office
```

The enrol code can also come from `AGENTUM_ENROLL_CODE`; the binary removes it
before starting its async runtime. `enroll <code> --server <url>` remains accepted.
All forms send the new RC.1 body, omitting `roles` so the code chooses them.
The two roles fixtures in `packages/protocol/fixtures` are the RC.1 handoff.
The protocol tests validate those fixtures with test-only schema extensions
until RC.1 lands; the old server parsers are unchanged.

User config/state roots follow XDG; `AGENTUM_CONFIG_DIR` and
`AGENTUM_STATE_DIR` override those roots. Each contains an instance subdirectory.
System enrolment uses `/etc/agentum` and `/var/lib/agentum`. Config files and
credentials are separate and private. An enrolment lock prevents two local
clients from spending codes on the same instance name. Server-derived names
get numbered suffixes on collision; explicit names fail before the HTTP call.

The transport in `relay.rs` is usable independently of the CLI run stub.
Implement `Role` and pass role objects to `run_roles`. A failing role
`prerequisites` check logs its explanation and disables only that role; exit 5
is returned when none can start. `on_frame` runs on the
read loop so a role can reserve an id before dispatching work. Its `Reply`
can be retained by a task: the bounded channel and generation belong only to
that socket, and a stale reply is refused after reconnect. Role work can outlive
a connection. `shutdown(Replaced)` aborts agent_host runs; computer handlers
preserve their commands. `Revoked`/`Stopped` end all work. A 4401 cancels both
socket tasks and returns exit 3. Retry timers, heartbeat styles, hello-ack timeout
and computer pong tracking remain separate per role.

`Config`, `RunAs` and `ComputerConfig` are the shared configuration contract.
The doctor registry has one file per area for RC.3/4/5. Cargo dependencies include
the process, watcher, hashing, image/X11 and streaming support those tasks need;
HTTP and WebSocket TLS use rustls with native CA roots, without OpenSSL.
Release builds can set `AGENTUM_VERSION` to the exact manifest version; local
builds use `<package-version>+<eight-character git sha>`.

Service operations, both run handlers and desktop are explicit exit-1 stubs.
Status reports connection state as `unknown` until the run handlers publish it.
Doctor checks filesystem privacy, service prerequisites, desktop packages,
Claude binary presence and server reachability. It never starts Claude.
Version, login and run-as execution probes belong to RC.4; desktop sandbox
checks belong to RC.5. Doctor does not authenticate a WebSocket because that
would evict the running role's connection. Tests use local fake servers and
never launch the real Claude CLI.
