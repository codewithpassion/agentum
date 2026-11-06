# Machine client boundaries

`cli`, `instance`, `enroll`, `wire`, `main` and `relay` provide the shared
foundation. `run` loads one config, applies temporary overrides (persisted only
with `--save`), constructs each configured role and calls `relay::run_roles`.
SIGINT/SIGTERM stop both roles; 4401 stops both with exit 3. Other disconnects
and missing prerequisites affect only their own role.

| Area | Modules |
| --- | --- |
| Service installation | `service`, `privilege/service`, `doctor/service` |
| Agent host | `runs`, `runs/`, `claude`, `approvals`, `library`, `files`, `privilege/agent`, `doctor/claude` |
| Computer | `computer`, `computer/`, `desktop`, `privilege/computer`, `doctor/computer` |
| Common diagnostics | `doctor/instance`, `doctor/network`, `privilege/common` |

## Roles and execution

The constructors are `runs::role` and `computer::role`. `Role::on_frame` reserves
work synchronously and dispatches asynchronous tasks. Tasks await `Reply::send`;
a reply belongs to its original socket generation and fails after disconnect.
Never await a reply on the socket's own read loop. Agent-host runs abort on
replacement; computer commands survive replacement and reconnects.

`runs::Host` queues one run per agent while allowing different agents to work in
parallel. `runs/executor` prepares files, skills and library, batches sequenced
events, maintains the lease, drives Claude, stops timers and completes after
process exit and final library sync. `claude` owns the stream-json handshake,
control callbacks, piped I/O and process-group TERM/KILL cleanup. `approvals`
fails closed while awaiting platform decisions. `library` handles read/write
roots, conflict copies, live changes and checkpoints. `runs/helpers` ports the
shared TypeScript helpers and masker; `runs/parity.ts` generates their fixtures.

`computer` dispatches policy-checked commands and file operations, records audit
entries, and owns desktop supervision. In agent-user mode, `computer/worker`
starts one copy of the resolved current binary through sudo with the sole
`--computer-worker` argument. Config and requests cross a private stdin pipe;
credentials never cross it. Worker death fails pending requests, retries startup
and eventually reports unavailability. File transfer retains the frozen v1 wire
format and limits. Shell process groups are recorded and swept with start-time
checks to avoid killing reused PIDs.

## Privilege and filesystem boundary

All roles use `Paths::work_root(name, run_as)`: current/named users use
`<state dir>/work`; agent-user uses `/var/lib/agentum/<instance>/agent/work`.
Use `Paths::agent_home` for user creation and `Paths::agent_work` for agent paths;
workspace/agent IDs allow uppercase letters, digits, `_` and `-`.

The system agent-user service runs as `agentum-<instance>-svc`. Its config is
0700, including a separate 0600 credential. Its state directory is 0710 with the
agent group so the agent can traverse to its own 0700 home beneath it; it cannot
list the service state. Other system modes keep state 0700. The resolved Agentum
binary and all ancestors must be root-owned and not writable by other users.

Service installation renders one per-instance sudoers drop-in. Claude needs
`SETENV` even without agent secrets because the driver preserves
`CLAUDE_CODE_ENTRYPOINT`; `CWD=*` permits its workdir. File utilities use
`NOSETENV`. The worker has a separate exact-argument rule from
`privilege::computer::worker_rule`. No shell rule is installed. Scoped
`!requiretty, !use_pty` defaults preserve piped protocols. Runtime command
builders are shared with tests that parse the rendered rules, including tags,
run-as users, cwd and argument restrictions, without invoking sudo.

Each privilege area declares its own `Problem` constants and rendering tests.
Shared filesystem/network explanations live in `privilege/common`; use the
actual config path in fixes. Doctor invokes every area's registry, showing
explicit skips where config or a role is absent, and never mutates the host.

Use `instance::locations`, `select`, `reserve` and `free_display` across both
user/system locations. Enrol reserves explicit names before spending a code;
post-issuance save failures preserve the credential in a private recovery file.
System namespace roots are 0755 so service users can traverse them; instance
config directories stay 0700. Unreadable instances appear in `list` as unavailable.
The transport atomically writes `connection-agent_host.json` and
`connection-computer.json` under instance state. Status and list read these last
observed states without connecting.

## Regression checks

`runs/tests.rs` checks HTTP contracts, fixtures, normalization, files, skills,
helper parity, approvals, relay delivery and library conflict handling.
`runs/review_tests.rs` already covers every executor case requested by the RC
integration review:

| Cases from daemon executor tests | Rust test |
| --- | --- |
| Complete once after exit; timers stop | `completion_is_once_after_exit_and_timers_stop` |
| Full argv/env; resume here/elsewhere/absent; deny-pattern secrets masked | `argv_env_cwd_budget_turns_resume_and_secrets_match_daemon` |
| SIGKILL after grace | `abort_escalates_to_kill_and_reaps_whole_group` |
| Abort during MCP handover | `abort_during_mcp_handover_reaps_and_completes` |
| 404 names input id; spawn failure posts failed | `spawn_failure_and_missing_input_name_the_failure` |
| Error keeps session; no-result stderr masks token; no stop on success/plain error | `mcp_warning_elicitation_error_session_and_masked_stderr` |
| Abort sends no library edits; checkpoint; late announcement does nothing | `library_abort_checkpoint_failure_and_late_announcements` |
| Unreachable library is nonfatal; failed sync-in prevents sync-out | `library_unreachable_is_warning_and_failed_sync_in_never_syncs_out` |
| No toolRules skips hook; empty rules still ask; waiting call keeps timers; abort denies and completes aborted | `no_rules_skips_hook_empty_rules_still_asks_and_waiting_gate_keeps_timers` |

`service` tests compare units to golden files, exercise fake privileged command
failures and check mode-specific credential warnings. Computer tests cover
protocol fixtures, policy, limits, file chunks, audit, root refusal, worker
recovery and desktop fakes, plus Xvfb when installed.

Use Bun scripts and `scripts/cargo.sh` for Rust commands on this host. The wrapper
bypasses the `cc` shim for native compilation and linking. Tests never start the
real Claude CLI by default; its conformance E2E requires `AGENTUM_CLAUDE_E2E=1`.
HTTP/WebSocket TLS uses rustls and native CA roots. Release builds can set
`AGENTUM_VERSION` to the exact manifest version; local builds append the git SHA.
