# Codex adversarial review (16 Oct 2026)


Target: working tree diff
Verdict: needs-attention

Do not freeze M0 yet. The design leaves credential scope, retry safety and durable admission unresolved; the managed-runtime reuse also requires an interface change the plan does not account for.

Findings:
- [high] Machine storage collapses workspace isolation (docs/architecture/build-plan.html:223-225)
  M1.4 stores agents under agents/<slug>, but slugs are unique only within a workspace (index.html, Data model). Two workspaces assigning an agent named 'bruce' to the same machine therefore share instructions, MCP configuration and working files. Different sessions of one agent can also overwrite the per-run MCP token because execution is serialized only per session. Native execution with bypassPermissions provides no filesystem boundary protecting the other configuration files.
  Recommendation: Use workspace and immutable agent IDs in storage paths, pass MCP configuration per invocation, and define an enforced isolation boundary or restrict each daemon to one explicitly trusted workspace. Test overlapping sessions and duplicate slugs across workspaces.
- [high] Proxy authorization does not enforce connector assignment (docs/architecture/index.html:314)
  Seam 4 validates the run token and looks up the requested connector, but never requires an agent_connectors assignment. The shared authz stub checks only workspace equality. Consequently, the specified checks allow a live run to request another same-workspace connector by ID and use its actor's credential, even when that connector was withheld from the agent. Omitting a URL from mcpServers is not authorization.
  Recommendation: Require a current workspace-scoped assignment on every proxy request, derive actor and credential mode from trusted rows, and reject revoked credentials explicitly. Freeze these invariants in C2/C6 and test unassigned connectors and mid-run revocation.
- [high] Refresh can race with other calls, re-authentication and revocation (docs/architecture/index.html:299-314)
  The per-call refresh design has no credential-level serialization or versioned persistence. Concurrent runs using one rotating refresh token can both refresh; one succeeds while the other fails and marks the valid credential needs_auth. An in-flight refresh can also overwrite a newer grant or revocation. Agentum's copied oauth.ts contains HTTP helpers, not this coordination; its refreshTokens comment explicitly describes refreshing a management copy.
  Recommendation: Specify a cross-invocation refresh lease and credential generation with conditional writes. Preserve revocation and newer grants against stale results. Add concurrent rotating-token, refresh-versus-revoke and refresh-versus-re-auth tests before freezing the credential schema.
- [high] Lease expiry automatically repeats potentially irreversible work (docs/architecture/build-plan.html:218-220)
  M1.3 requeues expired runs once, although loss of heartbeat does not prove the original Claude process stopped. It may already have sent an email or changed an external system. Re-execution can repeat that effect. Claims, tokens and completion bodies carry no attempt generation, so the plan also lacks a fence against late events or completion from the previous execution. The acceptance check only verifies that expiry is reaped.
  Recommendation: Treat expired executions as interrupted or outcome-unknown by default. Add attempt IDs to claims, tokens, heartbeats, events and completion; reject stale attempts. Permit automatic replay only for explicitly retry-safe work and test a partition after an external effect.
- [high] Slack acknowledges requests before durable admission (docs/architecture/build-plan.html:273-275)
  M5.1 sends 200 and then runs startRun through waitUntil. If identity lookup, D1 or the background invocation fails, Slack has already been told delivery succeeded. If the dedupe row was written first, a retry is suppressed without any run existing. There is no durable receipt or recovery consumer in the schema or milestone.
  Recommendation: Persist a deduplicated delivery receipt before acknowledging, then process it through a recoverable worker or sweep. Alternatively atomically admit the run before 200. Test failure after dedupe, after acknowledgement and before run insertion.
- [high] Advancing a routine before creating its run loses scheduled work (docs/architecture/build-plan.html:267-269)
  M4.2 explicitly advances next_run_at first and calls startRun afterward. A failure between those operations permanently skips the occurrence: the next tick sees a future schedule and has nothing to recover. The stated once-per-slot test does not exercise this failure window, and no stable occurrence key is specified.
  Recommendation: Atomically persist a run or dispatch intent keyed by trigger and scheduled occurrence while advancing the schedule. Recover dispatch from that durable state, and test crashes on both sides of the commit plus overlapping ticks.
- [medium] Header credentials cannot satisfy the user credential cases (docs/architecture/build-plan.html:249-251)
  M3.1 expressly makes header credentials agent-owned only. A connector authenticated with a personal API token therefore cannot act as Dom or the requesting colleague. With the default user_or_agent mode it instead produces needs_auth, with no supported user-owned header credential to resolve it. This contradicts the brief's combination of multiple authentication methods and three credential cases.
  Recommendation: Make credential ownership independent of authentication method. Support user-owned and agent-owned header secrets and exercise both through the same credential-mode matrix used for OAuth.
- [medium] Managed-session reuse cannot rotate the proposed per-run token (docs/architecture/build-plan.html:298-300)
  M8 assumes Agentum's gateway can create sessions with per-run MCP credentials. In the source, CreateSessionInput has no MCP configuration and createSession sends none; MCP configuration belongs to agent registration/sync. The reuse matrix also acknowledges that sessions retain their creation-time setup. Reusing a session therefore retains a token invalidated when its first run finishes; creating a fresh session each run loses the promised conversation continuity. The single-turn acceptance check misses both problems.
  Recommendation: Resolve session-scoped versus run-scoped authentication before freezing C3/C6. Specify the gateway changes and context preservation strategy, then require a two-turn managed-session test with different run tokens and concurrent sessions.

Next steps:
- Revise M0 contracts around capability checks, execution attempts and durable admission before starting parallel lanes.
- Replace happy-path-only milestone gates with the failure and concurrency checks identified above.
