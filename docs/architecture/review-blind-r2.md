# Blind review, round 2

Reviewed 16 October 2026 against the brief (`docs/log/2026-10-16-agent-platform-vision.md`), `index.html`, `reuse.html`, `build-plan.html`, the starting repo, and the source repos. I did not read `docs/analysis/`, earlier reviews or the review response.

## Verdict

Not ready to start M0 as written. It is close. Two problems sit inside things M0 freezes or that every service signature depends on. First, the run token expires with the lease and gets renewed by heartbeat, but Claude Code holds the claim-time token for the whole run, so every tool call fails after the first lease. Second, the `Database` type the services must take has no `batch`, yet the claim, Slack admission and routine tick all depend on "one D1 batch". Fix both on paper (C4, C6, C1/M0.2), then M0 can start. The majors can each land in their own milestone, but the machine-trust finding has to be settled before Slack lets colleagues reach agents (M5).

I checked every reuse path in `reuse.html` and all of them exist. The SDK 0.2.119 option claims, the Agentum `CreateSessionInput` claim, the oauth.ts and loop-guard imports, the flightdex-v2 MCP dependencies and the Previews binding rules (DO classes and migrations top level, bindings under `previews`, no crons in previews) also hold.

## Blockers

### B1. Run tokens expire mid-run, and the heartbeat refresh never reaches Claude Code

Pages: index.html, "Core seams" 3 and 4 and "Token prefixes". build-plan.html, C4, C6, M0.5, M1.3, M1.4.

What is wrong: `hm_run_` has "expiry equal to the run's lease and renewed by each heartbeat", and the heartbeat "returns a fresh token" that the daemon "adopts". But the token travels to Claude Code inside the `mcpServers` headers passed to `query()` once, at claim. Nothing updates the headers of a running Claude Code process. After the first lease ends, every `/mcp` and `/api/proxy/:c` call from Claude Code carries an expired token, and M0.5 says expired tokens are refused. No page gives a lease length. With a 20 s heartbeat it is presumably about a minute, which is shorter than most real runs.

Evidence: in SDK 0.2.119 `sdk.mjs`, process-type MCP servers go to the CLI as `l.push("--mcp-config", O$({mcpServers:Y4}))` at spawn. Only the daemon's own HTTP calls could use a refreshed token, and those use the machine credential anyway. The M1.4 checks (fake `queryFn`, the "pelican" e2e) all finish inside one lease, so they would pass.

Fix: make the run token live as long as the run (a hard cap such as 12 h). Fence it by `runs.status = 'running'`, which the resolver and proxy already check, and that check is the real fence. The heartbeat then only extends `lease_until` and returns `{}`. Change C4's heartbeat body and C6's claim set before they freeze. State the lease length (for example 90 s with a 20 s heartbeat). Add a test to M1.3: a token minted at claim is still accepted after three lease periods with heartbeats, and is refused the moment the run leaves `running`.

### B2. `Database` has no `batch`, but the atomic paths depend on it

Pages: index.html, module map `runs` ("claim as one D1 batch"), seam 5 (Slack admission), "Decisions" (routines in "one D1 batch"). build-plan.html, M0.4, M1.3, M4.2, M5.1. Repo rule in CLAUDE.md: "The parameter type is `Database` from `@repo/db`, which covers both."

What is wrong: `packages/db/src/schema.ts` defines `Database = BaseSQLiteDatabase<"sync" | "async", unknown>`. In drizzle-orm 0.44.7, `batch` exists on the D1 driver (`d1/driver.d.ts`) and not on `sqlite-core/db.d.ts` or the bun-sqlite driver. So a service that takes `Database` cannot call `batch`. A service that takes the D1 type cannot run on the `bun:sqlite` tests the repo requires. And D1 has no interactive transactions. Durable Slack admission (dedupe row plus run), routine insert plus advance, and `startRun`'s session, run and `run.queued` writes have no defined atomic mechanism, and their tests would run against a driver that cannot do it.

Fix: in M0.2, add one small atomic-write port to `@repo/db`, for example `atomic(db, (tx) => [stmt, stmt])`. It uses `db.batch` on D1 and a sync `transaction` on bun-sqlite. Services take `Database` plus that helper, or a `Database & { batch }` type with a bun-sqlite shim. Add a test in `packages/db` proving that a failing second statement rolls back the first on bun-sqlite. Add a local `wrangler dev` probe proving the same on D1. Write the rule into the `packages/db` README so the lanes do not each invent one.

## Major

### M1. The run token is world-readable in the process table

Pages: index.html summary ("held in memory on the machine and never written to disk"), seam 3 ("never writes a run token to disk"), "Auth and the three credential cases". build-plan.html M1.4 check (`grep -r hm_run_ ~/.harbourmaster`).

What is wrong: the SDK passes `mcpServers`, headers included, on the `claude` command line (see B1). Any process on the machine, under any Unix user, can read `/proc/<pid>/cmdline` or run `ps -ef`. Every concurrent Claude Code run can therefore read every other run's token, and so can the deferred per-agent Unix users. The M1.4 check looks at disk only, so it passes while the token sits in `ps` output.

Fix: start `query()` without the HTTP servers. Then, before the first user message (this needs streaming-input mode), call `query.setMcpServers({...})`. In 0.2.119 that sends `{subtype: "mcp_set_servers", servers}` over the control channel on stdin, not argv. Add to M1.4: during a fake run, `/proc/<claude pid>/cmdline` does not contain `hm_run_`. Record as an M1.4 probe that the servers are connected before the first turn.

### M2. A run can take other people's run tokens through the machine credential

Pages: index.html, "Auth and the three credential cases" (last paragraph), open question 7. build-plan.html M1.3.

What is wrong: the design concedes that a run can read `~/.harbourmaster/config.json`, which holds the machine credential. With that credential, a run can `POST /claim` a queued run of any agent on the machine and `POST /heartbeat` a running one. Both return a run token bound to that run's `on_behalf_of_user_id`, which can then be spent through the proxy with that person's connector credentials. The page says the blast radius is "act as any agent on the same machine". It is actually "act as any person who tasks any agent on this machine". Under `bypassPermissions` this needs no prompt injection: a linked colleague in Slack can ask the agent to `cat` the file and `curl` the heartbeat. That breaks credential case 2 ("acts under that colleague's credentials") and the page's "Nothing runs as Dom... by accident". A related leak: `settingSources: ["project"]` loads `.claude/settings.json` hooks and `.mcp.json` from the agent's directory, so one run can plant a hook that fires inside a later run started by someone else.

Fix, before M5 opens Slack to colleagues:
1. Heartbeat stops returning tokens (follows from B1).
2. Return a run token only once, from the claim that moves the run to `running`.
3. Run Claude Code as a separate Unix user from the daemon. One shared `hm-agent` user is enough to protect `config.json`, and it is a small step from the deferred `sudo -u` prefix.
4. Pass `strictMcpConfig: true`, and reset `work/.claude/` and `work/.mcp.json` before each run.

If step 3 stays deferred, change the v1 rule: runs on behalf of anyone other than the machine's enrolling user resolve only `agent` credentials. State the real blast radius in open question 7.

### M3. Anyone who signs up gets a workspace

Pages: index.html "Auth and the three credential cases", open question 6. build-plan.html M0.1.

What is wrong: "Workspace auto-created on first request from an org; a user with no org is redirected to Clerk's create-organization page." Clerk sign-up is open by default and the Worker sits on a public custom domain (`harbourmaster.rockyshoreslabs.io` in `wrangler.jsonc`). Any stranger can sign up, create an org, and get a full tenant. That tenant can register connectors to arbitrary URLs and use the proxy as an outbound relay, enrol machines and mint keys. The owner builds for himself first.

Fix: in M0.1, gate workspace creation on an allow-list (an injected `allowedOrgIds`, or Clerk restricted sign-up mode). Add a `principal.test.ts` case where an org not on the list resolves to null. Also add enabling Organizations on the Clerk instance to M0.1, because the repo's Clerk setup does not do it.

### M4. The checks need "a fake-runtime agent", but nothing can create one

Pages: index.html data model (`agents.runtime ('machine' | 'managed')`). build-plan.html M1.5 ("runtime fixed to machine"), and the checks in M2.1, M2.3, M4.1 and M6.1.

What is wrong: those checks run against `bun run dev` with "a fake-runtime agent". The schema enum has no `fake`, the UI fixes the runtime to `machine`, and no seed script is planned. The Access and Automation lanes start their checks before M1 exists, so they need this from day one.

Fix: in C1, add `fake` to `agents.runtime`, and register `FakeRuntime` only when a dev flag is injected into `createRunsService`. Add `bun scripts/dev/seed-fake-agent.ts` to M0.4, with a check that it prints an agent id the M2.1 smoke script can message.

### M5. A lost offer leaves a run queued forever

Pages: index.html seam 3, "Where things run" (tick jobs). build-plan.html M1.1, M1.3, M4.2.

What is wrong: `dispatch` marks the run `offered` and tells the relay. If the daemon is offline (a laptop asleep), or the socket drops before the claim, nothing offers the run again. The relay only offers "on a queued run", the tick list has no re-dispatch job, and the reaper only handles `running`. M4.2's check ("a crash after the batch and before dispatch leaves a queued run the next tick dispatches") assumes a job no page defines.

Fix: on `hello`, the relay reads the queued and offered runs for that machine's agents and offers them, oldest first. Add a "re-offer runs queued or offered for more than 60 s" job to the tick registry. Add an M1.1 check: start a run while the fake daemon is stopped, start the daemon, and the run completes.

### M6. "One run per agent at a time" is enforced only by the daemon

Pages: index.html seam 1 ("That is the whole concurrency story in v1, and it is also why one agent directory on a machine is safe"), seam 3 claim. build-plan.html M1.3.

What is wrong: the claim's conditional write checks the run status and the machine, not whether the agent already has a running run. Two daemon processes with the same credential (a systemd unit plus a manual `run`, or an old process still finishing after a 1012 replacement) can claim two runs of one agent. Both Claude Code processes then share one directory and fork the same resumed session. Nothing forces queue order inside a session either.

Fix: add to the claim `WHERE ... AND NOT EXISTS (SELECT 1 FROM runs WHERE agent_id = ? AND status = 'running')`, and refuse a claim when an older queued run exists for the same session. Add both cases to `runs-machine.test.ts`.

### M7. The OAuth callback is not bound to the person who completes it, and Connect links go to shared threads

Pages: index.html seam 4 (`needs_auth` with `authUrl`), "the three credential cases" (the reply "carries a Connect link"), data model `oauth_states`. build-plan.html M3.2, M5.1.

What is wrong: `oauth_states` stores the owner, but no page says the callback checks that the signed-in Clerk user is that owner. `resolveCredential` returns a ready `authUrl`, and the agent posts it into the Slack thread. Two failures follow.
- Whoever clicks the link binds their own external account to someone else's credential row. If Dom clicks a colleague's link, the colleague now acts as Dom.
- For an agent-owned `needs_auth` from a routine, any channel member who clicks connects their personal account as the agent's identity.

Fix: `authUrl` should point to a Harbourmaster page (`/connect/:connectorId?as=user|agent:<id>`) that requires a Clerk session and creates the `oauth_states` row at click time, with `initiator_user_id`. The callback refuses unless the session user equals the initiator. Agent-owned connects come only from the agent page. Restrict `return_to` to same-origin paths. Send the Slack link as an ephemeral message to the run's `on_behalf_of` user. Add M3.2 checks: a callback completed by a different signed-in user is refused, and an off-site `return_to` is refused.

### M8. The refresh design does not give "exactly one refresh"

Pages: index.html seam 4 (refresh paragraph). build-plan.html M3.3 check ("two concurrent calls that both see a 401 produce exactly one refresh").

What is wrong: the versioned conditional write orders the database writes. Both proxies still call the provider's token endpoint first. With rotating refresh tokens, the second call gets `invalid_grant`, and some providers revoke the whole token family on reuse. That can end with the credential in `needs_auth` for everyone. If the stub counts token-endpoint calls, the check fails against this design. If it counts writes, it passes and proves nothing about the provider.

Fix: take a refresh lease before calling the provider: `UPDATE credentials SET refreshing_until = now+30s WHERE id = ? AND version = ? AND (refreshing_until IS NULL OR refreshing_until < now)`. Only the winner calls the provider. Losers poll for `version` to change, for at most 5 s. Refresh ahead of time when `expires_at` is within 2 minutes, so most refreshes never race. Make the stub count token-endpoint calls, and assert one.

### M9. Page ownership contradicts itself, so the lanes collide in UI files

Pages: build-plan.html M9 vs M1.5, M2.1, M2.2, M3.1, M4.1, M5.2, M6.1, M7.1, and the lane table ("Each lane owns its own files after M0.7").

What is wrong: M9 gives the Automation lane "Machines, Connectors, Triggers, Inbox, Settings (API keys, connected apps...)". The service milestones already build those pages: the Machines page in M1.5 (Runtime), the settings page in M2.1 and connected apps in M2.2 (Access), the Connectors page and the agent's Connectors tab in M3.1 (Access), Triggers in M4.1, and Inbox in M6.1. The agent page is edited by Runtime (M1.5 chat, M5.2 Slack panel, M7.1 upload) and by Access (M3.1 tab). The nav shell lands in M1.5, but Access needs it for M2.1 straight after M0. M0.7 pre-splits server wiring and none of the UI.

Fix: cut M9 down to the Sessions and Log pages. Move the shell, with a nav registry each lane appends to from its own file, into M0.7. Pre-create the agent page with one tab file per lane (chat, connectors, slack, triggers).

## Minor

1. **index.html "Where things run", Worker `scheduled()` row.** The tick handles "stale run leases (mark failed)", but everywhere else an expired lease means `interrupted`. Change it to `interrupted`.
2. **index.html seam 1 vs seam 5 and build-plan M0.4.** `startRun(db, principal, input)` is a free function in one place and a method of `createRunsService({ db, adapters, gateways, blobs, clock })` in another. `resolveCredential(db, {...})` returns decrypted secrets but takes no key, and under the "never reads env" rule it must be injected. Write both as factories with their dependencies (`createCredentialsService({ db, secretsKey, clock, fetch })`) before C3 is coded.
3. **index.html seam 6 and seam 1 (C2, C3).** The `Principal` union has no kind for a Slack-signed request or a tick-started routine, yet `startRun` takes a principal. `actor` is also a caller-supplied input that outranks `principal.kind === "run"` in the `on_behalf_of_user_id` derivation. Add a `gateway`/`system` principal kind, and derive `actor` from the principal everywhere except in gateway routes. C2 freezes at the M1 gate, before Slack exists, so decide this before the gate.
4. **build-plan M1.1, M0.7 and M0.8 checks.** The relay imports `DurableObject` from `cloudflare:workers`, which `bun test` cannot resolve. Ariadne needs `apps/web/bunfig.toml` with `tests/cloudflare-workers-shim.ts` for this. `apps/web`'s `test` script is `bun test scripts`, so new tests in `src/` are not run by `turbo run test`, and a root `bun test` does not read a package's bunfig. Copy the Ariadne shim in M0.7, change the script to `bun test`, and have CI run `bun run test`.
5. **build-plan M0.2 check.** The append-only triggers are proven only on bun:sqlite. Add `wrangler d1 migrations apply DB --local`, then `wrangler d1 execute DB --local --command "DELETE FROM events"`, and expect a failure, because wrangler, not drizzle, applies the real migration.
6. **build-plan M1.4 and reuse.html "Agent core".** `CLAUDE.md` is written to `<agentId>/` while `cwd` is `<agentId>/work/`. It is picked up only by parent-directory lookup, which `settingSources` does not obviously govern, and the M1.4 checks do not prove the agent sees its instructions. Pass the instructions through `systemPrompt: { preset, append }` (bruce-next `agent.ts:255` already does this), or add a fixture check that the instructions reach the model.
7. **index.html seam 1 and build-plan M2.1.** `send_message` from a run lets agents call each other with no depth cap, and no parent run is stored. Combined with "one run per agent" and `waitMs`, a cycle A→B→A waits until timeout. Add `runs.parent_run_id` and a depth cap (3), and refuse a `send_message` that waits on a busy ancestor. The inbox already has a loop guard, so the two paths are inconsistent today.
8. **build-plan M7.1.** "A run token can upload and download for its own session only" breaks for a file uploaded in the composer before the message creates the session. Scope downloads to the `fileIds` of the run's input, plus files the run uploaded itself.
9. **index.html v1 scope, "Google Drive".** "Reached as a remote MCP connector... No Drive-specific code" names no server, and Drive has no official remote MCP server with dynamic registration. Name the server, or move Drive to Deferred. Add an M3.2 live check against it.
10. **reuse.html "OAuth client approval gate".** The risk column says "the Clerk instance is shared with other apps". Harbourmaster's publishable key points at its own instance (`faithful-falcon-1887`), while flightdex-v2 uses `proven-jaguar-455`. The gate is still needed because tokens carry no audience, but correct the stated reason. Also say how an OAuth principal's workspace is chosen (from the approval row, as flightdex-v2 does), and make `client_id` unique across workspaces.
11. **build-plan M0.2.** All 20 tables, including Slack, inbox and files, are created and frozen at M0, months before those milestones test their shape. The serial migration queue already exists, so create only the M0/M1 tables in C1 and let each lane add its own tables in its first PR.
