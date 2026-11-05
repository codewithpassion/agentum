# Machine client boundaries

`cli`, `instance`, `enroll`, `wire`, `main` and the connection loop in `relay`
are the RC.2 foundation. `run` loads one config, applies temporary overrides
(persisted only with `--save`), constructs each configured role and passes them
to `relay::run_roles`. SIGINT/SIGTERM stop both roles; 4401 stops both with exit 3.
Other disconnects and missing prerequisites affect only their own role.

| Task | Owned files |
| --- | --- |
| RC.3 service installation | `src/service.rs`, `src/privilege/service.rs`, `src/doctor/service.rs` |
| RC.4 agent_host | `src/runs.rs`, `src/runs/`, `src/claude.rs`, `src/approvals.rs`, `src/library.rs`, `src/files.rs`, `src/privilege/agent.rs`, `src/doctor/claude.rs` |
| RC.5 computer | `src/computer.rs`, `src/computer/`, `src/desktop.rs`, `src/privilege/computer.rs`, `src/doctor/computer.rs` |

The role constructors are `runs::role` and `computer::role`. Fill those modules
without changing the CLI dispatch or transport. They currently send hello and
log frame kinds; they do not execute work. `Role::on_frame` reserves work
synchronously and dispatches asynchronous tasks. Those tasks await `Reply::send`;
a reply belongs to its original socket generation and fails after disconnect.
Do not await a reply on the socket's own read loop. Agent_host aborts runs on
replacement; computer commands survive replacement and reconnects.

All three tasks use `Paths::work_root(name, run_as)`: current/named users use
`<state dir>/work`; agent-user uses `/var/lib/agentum/<instance>/agent/work`.
RC.3 creates that agent home with mode 0700, owned by `agentum-<instance>`.
Use `Paths::agent_home` for user creation and `Paths::agent_work` for agent paths;
workspace/agent IDs allow uppercase letters, digits, `_` and `-`.

Each privilege area declares its own `Problem` constants and rendering tests.
There is no shared problem registry to extend. Shared filesystem/network
explanations live in `privilege/common.rs`; use the actual config path in fixes.
Each doctor area owns its checks in its matching file.

Use `instance::locations`, `select`, `reserve` and `free_display` across both
user/system locations. Enrol reserves explicit names before spending a code;
post-issuance save failures preserve the credential in a private recovery file
in the instance directory (or config root if the instance cannot be created).
System namespace roots are 0755 so service users can traverse them; instance
directories stay 0700. Unreadable instances appear in `list` as unavailable.
The transport atomically writes `connection-agent_host.json` and
`connection-computer.json` under the instance state directory. `status` and
`list` read these files without connecting. They record the last observed state.

Use Bun scripts and `scripts/cargo.sh` for Rust commands on this host. The wrapper
bypasses the `cc` shim for both native compilation and Rust linking. Never start
the real Claude CLI during ordinary checks; the later driver E2E test requires
`AGENTUM_CLAUDE_E2E=1`.
