# Blind review of the Harbourmaster v1 design

Reviewed 16 October 2026 against the brief, the three architecture pages, the starting repo and the source repos named in reuse.html. I did not read docs/analysis/.

## Verdict

The design is buildable and mostly lean. The reuse claims hold up. I checked about 110 named paths and all but one exist at the stated line counts. The SDK claims also check out: `McpHttpServerConfig` takes `headers` (bruce-next sdk.d.ts:926), Ariadne's relay uses hibernation plus an alarm, its manifest has `features.agent_view`, and its service installer refuses darwin. The weak spot is the credential model, the one thing the design says it gets right. Agent-to-agent and inbox runs launder a person's request into the agent's own credential. Concurrent sessions of one agent share a `.mcp.json` that holds a run token. Three frozen M0 contracts also break the repo's "services never read env" rule. Fix those three before M0 freezes anything. The other problems are fixable inside the plan: hidden dependencies on the ops lane, a deploy order Cloudflare rejects, checks that cannot run as written, and one silent cut from the brief (agent secrets).

On future work, the plan is lean apart from four things. Managed Agents is a v1 milestone, per-agent Slack apps go through a manifest API no repo has used, O.2 builds a release pipeline, and ten lanes are planned for a team of one to three. See M12, M13, m18, m19 and m20.

Counts: 3 blockers, 13 major, 20 minor.

## Blockers

### B1. Agent-to-agent and inbox runs use the agent's credential for a person's request

Page: index.html, "Core seams" 1 and 4, and "Auth and the three credential cases". The C3 contract freezes this in M0.4.

What is wrong. `Actor` has a `{ kind: "agent" }` variant, and the `user_or_agent` rule says "No human actor (routine, HTTP trigger, agent-to-agent) uses the agent's credential." A run started by agent A through the MCP `send_message` tool, or by an agent's inbox post that mentions another agent, therefore runs with the target agent's own credential. A colleague with no Notion credential can mention agent A in Slack and ask it to "message yourself" or "message B to search Notion". That run resolves to the agent credential, so the colleague gets around `needs_auth`. The design promises the opposite: "Nothing runs as Dom by accident."

Evidence. index.html seam 4: "user_or_agent (default). ... No human actor (routine, HTTP trigger, agent-to-agent) uses the agent's credential." Seam 1: `| { kind: "agent"; agentId: string }`. M6.1: "actor the poster", where the poster can be an agent.

Fix. Give every run an `onBehalfOf` field that holds the originating human, or null. A run started from a run token inherits the parent run's `onBehalfOf`. An inbox post by an agent carries the run that wrote it, and that run's `onBehalfOf` applies. Credential resolution reads `onBehalfOf` first and uses the agent credential only when it is null, which leaves routines, HTTP triggers and runs descended from them. Add the chain case to `credentials.test.ts` in M3.3: a user, then agent A, then agent B, with the user lacking a credential, must end in `needs_auth`.

### B2. One agent directory and one `.mcp.json` shared by concurrent sessions

Page: build-plan.html M1.4. index.html "Where things run" (the Claude Code row) and "Core seams" 4.

What is wrong. The daemon writes `.mcp.json` "from the claim's mcpServers" into `~/.harbourmaster/agents/<slug>/`. The run token sits in that file. The plan allows concurrent runs on different sessions of the same agent, since it says "one run per session at a time". When session 2 starts, it overwrites the file with its own token. If Claude Code reloads the file, session 1's tool calls go out with session 2's token, and the proxy then injects session 2's actor credential. Both sessions also share `work/`. The file is not needed in the first place. The SDK takes `mcpServers` as a query option, and bruce-next passes it that way (agent.ts:269).

Evidence. M1.4: "write CLAUDE.md from the agent's instructions and .mcp.json from the claim's mcpServers, run query() with cwd = work/". index.html seam 1: "The daemon runs one run per session at a time."

Fix. Pass `mcpServers` in memory through `query()` options only, and never write a run token to disk. Give each session its own work directory, `agents/<slug>/sessions/<sessionId>/`, or serialise runs per agent in v1. Add a daemon test with two concurrent fake runs on one agent. It asserts that each run's MCP config carries its own token and that no file under `~/.harbourmaster` contains `hm_run_`.

### B3. Frozen contracts pass `env` into services

Page: index.html "Core seams" 5 and 6 and "Module map". build-plan.html C2, C5, C7 and M0.3.

What is wrong. The root CLAUDE.md says a service "takes a `Database` and never reads `env`". Three of the contracts frozen in M0 take `env`: `resolvePrincipal(db, env, authorization)`, `append(db, env, event)` and `Gateway.deliver(db, env, target, message)`. Every lane consumes them, so the violation spreads before anyone can push back. It also makes the services harder to test with `bun:sqlite`, because tests must fake a whole `Env`.

Evidence. index.html seam 6: `resolvePrincipal(db, env, authorization: string | null)`. Seam 5: `deliver(db, env, target, ...)`. M0.3: "append(db, env, event) writes the row, or an R2 object". Root CLAUDE.md, "Services and tRPC".

Fix. Inject narrow dependencies when the service is built, the way `createNotesService(db)` works today. Examples: `createEventsService({ db, blobs })`, where `blobs` has `put` and `get`, and `resolvePrincipal({ db, runTokenKey, verifyClerkToken })`. Gateways get their Slack client from a factory at registration. Write these signatures into C2, C5 and C7 before M0 merges.

## Major

### M1. The proxy never checks that the connector is assigned to the run's agent

Page: index.html seam 4 ("The proxy route"). build-plan.html M3.3.

What is wrong. The proxy steps are "verify the run token, look up the connector, resolve the credential, forward". `resolveCredential` takes `agentId` and reads `credential_mode` from `agent_connectors`, so the row is consulted. But neither page says what happens when no row exists for `(run.agentId, connectorId)`. If resolution falls back to a default mode, any run token can call `/api/proxy/<any connector id in the workspace>` with its actor's credential, including connectors the agent was never given.

Fix. Say it explicitly: no assignment row means 403 before any credential lookup. Add the case to `proxy.test.ts`.

### M2. The machine credential and every agent's files are open to any agent on the box

Page: index.html "Auth and the three credential cases" ("Secrets never reach the daemon, Claude Code..."), open question 7, "Deferred" (canUseTool row). build-plan.html M1.4.

What is wrong. Claude Code runs as the daemon's Unix user with `bypassPermissions` and Bash. It can read `~/.harbourmaster/config.json`, which holds the `hm_mach_` credential, plus every other agent's directory and the machine's Claude login. With the machine credential, a prompt-injected run can claim other queued runs for that machine and receive their run tokens, which carry other people's credentials through the proxy. Open question 7 says "Bash, Edit, Write inside the agent's work directory". `bypassPermissions` confines nothing to a directory. Two smaller points. The SDK 0.2.119 typings say `bypassPermissions` "requires `allowDangerouslySkipPermissions`" (sdk.d.ts:1443 and 1459). bruce-next omits it and reportedly runs today, so one of the two is wrong. Verify before M1.4. I also expect `canUseTool` is skipped in bypass mode, which would make the "approval gate later" seam a mode change rather than a hook. The typings do not say either way, so check it.

Fix. State the trust boundary plainly: in v1, every agent on a machine can act as the machine. Bind machine claims to runs offered to that machine over its live socket. Rotate the machine credential on each connect if that is cheap. Correct question 7's wording. Settle the `allowDangerouslySkipPermissions` question in M1.4 with a fixture test. Move the per-agent Unix user from silent omission into the Deferred table, with the brief's "dedicated directories and/or user accounts" as the reason. The seam is the daemon's spawn prefix, the same one Docker uses.

### M3. Slack channel-watch runs have no defined actor

Page: build-plan.html M5.1. index.html open question 8.

What is wrong. "Channel-watch triggers (kind: slack_channel, mode all) start a run per top-level message with a per-day session." The plan never says who the actor is. If it is the trigger, the default reading since the row lives in `triggers`, then anyone who can post in the channel gets the agent's credentials and a shell on Dom's box. That includes Slack Connect guests from other companies. The per-day session also means one person's message lands in context next to another's.

Fix. The actor is the poster, resolved through `identity_links`. An unknown poster, including any external or guest user, starts no run, or a run with no connectors. Add both cases to `slack-events.test.ts`.

### M4. API keys and OAuth clients keep working after a user leaves the Clerk org

Page: index.html seam 6 and "Auth and the three credential cases". reuse.html "Platform MCP server" (authenticate.ts row, "Copy", Medium).

What is wrong. The workspace comes from the session's `orgId` claim. A bearer token has no session. `hm_key_` keys and approved OAuth clients carry their workspace in a D1 row, and nothing re-checks Clerk org membership on use. The flightdex-v2 code the design copies checks membership on every request (authenticate.ts:11-16 and 237-241, `isMember`), but against its own members table and verified email. The design drops that table, so "Copy" understates the work. This is a real rewrite of the membership check.

Fix. In `resolvePrincipal`, check org membership for `api_key` and `oauth` principals through Clerk's Backend API with a short cache, or revoke keys and clients on Clerk's `organizationMembership.deleted` webhook. Relabel the reuse row "Borrow". Add a test: remove a member, and the next `/mcp` call is 401.

### M5. The deploy order cannot create the Durable Object

Page: build-plan.html O.1. index.html "Where things run" (the cron row).

What is wrong. O.1 says "build, versions upload, migrate, versions deploy, wrangler triggers deploy". Cloudflare rejects `wrangler versions upload` for any change that creates, deletes or renames a DO class, and says to use `wrangler deploy` instead (developers.cloudflare.com/workers/versions-and-deployments/deployment-management, "Durable Object migrations"). The first deploy of MachineRelay fails, and so does M8's ManagedPoller. The repo's own `deploy` script already uses `wrangler deploy`. A smaller point: index.html puts the DO binding "in all three places". The previews docs say to keep classes and migrations at the top level and add only the binding under `previews`.

Fix. Use `wrangler d1 migrations apply --remote`, then `wrangler deploy`, for any release that changes a DO class. Use the versions flow only for releases that do not. Say which applies in O.1 and in the M8 task.

### M6. Schema v1 is frozen but already incomplete, and there is no rule for later changes

Page: build-plan.html C1, M0.2, M1.3, M4.2, M9. index.html "Data model".

What is wrong. C1 freezes the 20 tables, and "a lane that needs one does not start until it is merged". The plan already needs columns the data model lacks:
- `triggers.consecutive_errors` (M4.2 and reuse.html, absent from the triggers row)
- a run attempt count for "re-queues once" (M1.3)
- a workspace timezone (M9 Settings, reuse.html cron row)
- somewhere to keep the Slack configuration refresh token (M13)

drizzle-kit keeps one `migrations/meta/_journal.json` and a snapshot chain. Two lanes that each add a migration on parallel branches will conflict on every merge.

Fix. Add the missing columns to C1 now. Write the rule down: after M0, schema changes go through one serial queue, one small PR per change, and lanes rebase and regenerate rather than merge migration files. Each lane keeps its tables in its own `schema/<module>.ts`.

### M7. Parallel lanes all edit the same few files

Page: build-plan.html "Contracts to freeze first", "Dependency graph", M0.7.

What is wrong. The contracts are frozen, but the wiring files are not split up. Every lane adds routes to `apps/web/src/server.ts`, a service to `server/trpc/context.ts` and to its add-clerk template copy (root CLAUDE.md: "Change both"), a router to `router.ts`, and an entry to `packages/services/package.json` exports. Lane D, along with E's purges, adds work to `scheduled()`. Lanes E and F add gateway implementations to the registry inside `runs.ts`. That is seven lanes merging into five shared files.

Fix. M0.7 pre-mounts one empty Hono sub-app and one empty tRPC router per lane, adds a tick registry that each lane appends to from its own file, and puts every planned service in `context.ts` and the template as a stub. Gateways register by injection, not by editing `runs.ts`. Each lane then touches only its own files.

### M8. Nobody owns "the daemon downloads fileIds"

Page: build-plan.html M1.4, M5.3, M7.1, and the lane table.

What is wrong. M7.1's check ("attach a text file ... ask the agent to quote it") says it "needs M1.4 to download fileIds". M1.4's scope does not include downloading. M5.3 says "the daemon downloads them into work/inbox/ before the run", but M5.3 is lane E's task and the daemon is lane A's. The lane table says G "Waits on later: Nothing".

Fix. Add the download to lane A as an explicit task after G merges, for example M1.6, "daemon fetches fileIds with the run token into work/inbox/". Make M7.1 and M5.3 depend on it, and fix G's row.

### M9. Several checks cannot run as written

Page: build-plan.html M0.1, M1.1, M1.5, M9.

What is wrong. The workspace requires an active Clerk org, but `apps/web/scripts/create-dev-user.ts` creates a user with no org. Every dev-login browser check then lands on the create-organization screen. M0.1's `curl -b <clerk cookie> localhost:3000/api/trpc/me` and M1.1's `curl -X POST .../machines.createEnrollToken (dev-login cookie)` need a Clerk cookie, and dev login gets its session by redeeming a sign-in token client-side. Clerk's `__session` JWT also expires after about 60 seconds. reuse.html records a related flightdex lesson: "redeem can fail on the first try in a fresh browser context".

Fix. Extend `create-dev-user` to create an org and a membership, and have `/dev-login` set the active org. Replace the curl-with-cookie checks with bun tests that call the router with a built context, plus the dev-login browser script for the end-to-end path. Alternatively, add a dev-only script that mints a session token through Clerk's Backend API right before the curl.

### M10. Hidden dependencies on the ops lane

Page: build-plan.html M1 gate, M2.2, and the lane table.

What is wrong. The M1 gate requires "the same daemon installed as a service on a second machine answers from the deployed Worker". That needs a deployed Worker with D1, secrets and DO (O.1) and, in practice, the install script and release (O.2). M1 lists neither. M2.2's live check ("add Harbourmaster as a connector in Claude.ai") needs a public HTTPS URL. The lane table says B waits only on F.

Fix. Add O.1 to the M1 gate's dependencies. Either add O.2 too, or let the gate copy the binary by hand. Add "O, or a tunnel" to lane B's row. The cloudflared quick-tunnel recipe from M8 works for M2.2 too.

### M11. "Secrets kept in vaults that can be given to agents" is dropped without saying so

Page: index.html "v1 scope" and "Deferred". Brief, "MCP connectors and credentials".

What is wrong. The brief lists vault secrets for agents separately from connectors. The design covers only connector credentials and says "Secrets never reach the daemon". An agent that needs a token in its shell, such as a GitHub token for `gh` or an API key for a CLI, has no path. The item is not in the Deferred table either, so the owner would not know it was cut.

Fix. Either add a Deferred row with its seam, or add a small v1 feature: agent-owned secrets of a new `env` kind that the claim response returns as env vars for that run only, with the masker covering them. If deferred, name the seam: the claim response gains an `env` map, and the masker adds needles.

### M12. The SMB path is the last milestone

Page: index.html "v1 scope", "Decisions" (first row), open questions 2 and 10. Brief, "The vision".

What is wrong. The brief's first sentence is "Make it simple for an SMB to build an agent." Until M8, the only runtime needs a Linux box, a systemd user unit, linger and a `claude login` per machine. Managed Agents, the one runtime an SMB could use without a machine, comes last. Open question 10's default is the machine's own Claude login. The design does not check whether Anthropic's terms allow a subscription login to serve other people's requests through an Agent SDK product. That matters once colleagues and SMB users task the agent.

Fix. Ask the owner whether v1 is "Dom first" or "SMB first", and record the answer in the decisions table. If SMB first, move M8 up to follow M3. If Dom first, cut M8 from v1 entirely and keep only the RuntimeAdapter seam, which is what "do not invent the future" asks for. A last milestone that nobody needs yet is the plan's largest piece of future work. Either way, check the Agent SDK terms on subscription login for question 10, and record API-key auth as the fallback.

### M13. The Slack configuration token expires in 12 hours, and the design has nowhere to keep its refresh token

Page: index.html open question 1. build-plan.html M5.2. reuse.html Slack, "App creation through Slack's manifest API" row.

What is wrong. Question 1 says "You paste one app configuration token once; every agent's app is created from it." reuse.html itself notes "Configuration tokens rotate every 12 hours". Creating a second agent's app the next day needs a stored refresh token, which rotates on every use. No table holds it.

Fix. Either paste a fresh token for each app creation, which is simplest and fits v1, or add a `slack_config_tokens` row per workspace with the encrypted token, the refresh token and an expiry, and rotate it with `tooling.tokens.rotate` before use. Build the manifest-paste fallback first, since every source repo already has it, and add the API path on top.

## Minor

### m1. M1.4's resume check does not prove resume
build-plan.html M1.4. "Sends 'and now the word heron', asserts the session's runtime_ref is unchanged (resumed) and the reply contains 'heron'." A fresh session also answers "heron", and an unchanged `runtime_ref` may just mean the daemon never updated it. Fix: ask "Which word did I ask for first?" and assert "pelican".

### m2. Two ways to claim a run
index.html seam 3 lists a WebSocket `{ type: "claim", runId }` frame and also `POST /api/machines/runs/:runId/claim`. Fix: drop the WebSocket frame. The HTTP claim is the compare-and-set step.

### m3. The lease reaper contradicts itself
build-plan.html M1.3: "Lease reaper marks stale runs failed and re-queues once." A run cannot be both failed and re-queued, and no column counts attempts. Fix: add `runs.attempt`. Re-queue when the attempt count is below 2, otherwise mark the run failed.

### m4. `request_id` uniqueness differs between pages
index.html seam 1 says "unique per workspace". The data model says "request_id unique null". Fix: make it a unique index on `(workspace_id, request_id)`.

### m5. "Every table has workspace_id" is not true of `workspaces`
index.html data model and M0.2's `schema.test.ts`. The `workspaces` row has no `workspace_id`, and drizzle's `__drizzle_migrations` table will also fail the PRAGMA check. Fix: the test exempts both by name.

### m6. Two different AAD bindings for encrypted secrets
index.html data model: "AAD workspace:connector:owner". reuse.html Foundations: "{ workspaceId, table, rowId, field }". Fix: pick one. The row-based form also covers `slack_apps` and `connectors.oauth`.

### m7. Google Drive is "deferred" but shown as a connector
index.html Deferred lists "Google Drive, OneDrive...". The system diagram shows "Remote MCP servers: Notion, Drive, The Brain". The brief asks for Drive in its "Files" section. Fix: say v1 reaches Drive through a remote MCP connector. Only file-landed triggers and Samba are deferred.

### m8. Exceptions to the repo's CLAUDE.md are not recorded
Root CLAUDE.md says "The app reaches it only through tRPC" and documents `protectedProcedure`. The design adds many Hono routes that call services directly (`/mcp`, `/api/proxy`, machine, Slack, trigger and file routes) and replaces `protectedProcedure` with `workspaceProcedure`. The top of CLAUDE.md also says "Don't use vite", while the app runs on Vite. Fix: add a task in M0 that updates CLAUDE.md and the services README with the route exception and the new procedure. Note that the Bun.serve and Vite text applies to `apps/daemon`, not `apps/web`.

### m9. Reuse paths and "Copy" labels that need correction
reuse.html Slack, the dedupe row: `flightdex-v2/apps/web/src/server/webhooks/webhooks-state.ts` does not exist. Only `routes.ts` and `routes.test.ts` are in that folder. `agentum/.../router/loop-guard.ts` imports `#/modules/messaging/service` and `./config`. Its logic is "N agent messages in a row until a human speaks, plus a per-agent wake budget". M6.1 describes "chain deeper than 3 or more than 10 agent posts per thread per hour", which is different. `agentum/.../connectors/oauth.ts` imports `./schema`, and the matrix leaves it out. Fix: correct the path, list `schema.ts`, and either describe the guard as Agentum's or mark it "Borrow".

### m10. CSRF protection covers only tRPC
`apps/web/src/server.ts` applies `csrf()` to `/api/trpc/*` only. New routes that take a cookie session, such as `POST /api/files` (multipart, a "simple" request), `/api/connectors/oauth/start` and Slack install, need it too. Fix: apply `csrf()` to every cookie-authenticated non-GET route, and ignore cookies on routes meant for bearer tokens.

### m11. Slack identity linking trusts any matching Clerk user
build-plan.html M5.1 and reuse.html Slack, "user to platform user by verified email". The email match should also require that the Clerk user belongs to the workspace's org, and that the event's `team_id` matches the `slack_apps` row found by `api_app_id`. Fix: add both checks and a test for each.

### m12. M0.7's scheduled-handler curl is unverified under the Vite plugin
build-plan.html M0.7 hedges with "or /__scheduled under plain wrangler dev". Fix: make the required check a bun test of the tick function, and treat the curl as a manual extra.

### m13. A tick event every minute fills an append-only log forever
index.html event types list `tick`, M0.7 appends one per tick, and "events grows without bound in v1". That is 1,440 rows a day nobody needs. Fix: log a tick only when it did work, or write it to `console.log` for Workers observability.

### m14. Conversation context crosses actors in shared threads
index.html seam 1 and open question 8. A Slack thread or inbox thread is one Claude Code session that resumes across posters. Tool results fetched with Dom's credential stay in context when a colleague posts next. Fix: state this in question 8 so Dom knows. If it matters, key Slack sessions by `(thread, actor)`.

### m15. The M0 estimate is low
build-plan.html M0 says "about a week for one person". It holds three M tasks (1 to 3 days each) and five S tasks (under a day each), which is about 1.5 to 3 weeks. Fix: restate it. Everything else waits on M0.

### m16. Release targets outrun the installer
build-plan.html O.2 builds darwin arm64. Ariadne's `install-service.ts:175` refuses darwin, and launchd is deferred. `harbourmaster run` in a terminal still works on macOS, so the binary has some use. Fix: keep linux x64 and arm64 in v1 and add darwin with launchd.

### m17. The run token's lifetime is unspecified
index.html seam 6 gives the run token's claims as "run id, agent id, workspace id, expiry" but never the expiry. M0.5 sets no value either. Long runs need either a long expiry or renewal on heartbeat. Fix: set expiry to the lease, extend it on each heartbeat by returning a fresh token, and keep the `runs.status` check.

### m18. O.2's release pipeline is more than the M1 gate needs
build-plan.html O.2 has a GitHub workflow, R2 uploads, `latest.json`, an install-script route and three targets. The one second machine in the M1 gate can take a binary copied by `scp`. Fix: defer O.2 until a machine outside Dom's control needs installing. The M1 gate copies the binary by hand.

### m19. Ten lanes and seven contracts for one to three people
build-plan.html "Suggested order" plans for one person, or three. Ten lanes with seven frozen contracts pay the full coordination cost of parallel work: a long serial M0, fixed contracts, and the shared-file problem in M7. Fix: keep the contracts that cross a process or network boundary (C1, C4, C6). Let C3, C5 and C7 harden during M1 rather than freezing them up front. Name three lanes, not ten, to match the staffing.

### m20. Watch-all Slack mode starts a full Claude Code run per message
build-plan.html M5.1 and index.html question 8. Every top-level message in a watched channel starts a Claude Code session on Dom's machine, with no filter and no budget. The brief asks for "monitor all messages ... and be proactive", so the feature belongs in scope, but the cost is not stated anywhere. Fix: ship mention mode in v1 and add watch-all when a cheap filter exists, such as a small model that decides whether to wake the agent. If it stays, put a per-channel daily run cap in the trigger config.
