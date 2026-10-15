---
type: "analysis"
title: "Agentum repo analysis"
tags: ["harbourmaster","agentum","analysis"]
visibility: "private"
---

> **Constraint from Dom (16 Oct 2026):** do not use Agentum's user interface (`components/`, `routes/`, `lib/` UI code, the Slack-like workspace shell, agent rail, dialogs, wizards) as an example or source for Harbourmaster's UI. Only its backend modules, protocols and the Go computer daemon are candidates for reuse. UI rows in the tables below are kept for reference only.

# Agentum (`/home/roboto/devel/agentum`)

Analysed 16 Oct 2026 from code, `PROGRESS.md` (19 cycles) and `docs/plan-*.md`. Claims below were checked against source unless marked "docs only".

## 1. Purpose

Agentum is a multi-tenant web app where a team creates agents, puts them in Slack-like channels and Slack itself, and gives each one tools: MCP connectors, skills, a wiki, a browser, and a computer (files, shell, optional Linux desktop). Each agent runs on Claude Managed Agents or on a home-grown loop on Cloudflare (Workers AI or AI Gateway). The self-hosted computer is a small Go daemon that dials out to the app, so a machine behind NAT becomes an agent's computer. The product is live at agentum.rockyshoreslabs.io and agentumbot.io. It is much larger than the brief's "agent with a remote desktop" summary.

## 2. Stack and deployment

- **Languages:** TypeScript (about 97k lines in `apps/web/src`, 133 unit test files) and Go 1.23 (`apps/computer`, about 11k lines, 18 test files).
- **Monorepo:** Bun workspaces and Turborepo (`apps/*`), Biome via Ultracite, husky pre-commit lint across the whole repo.
- **Web app:** TanStack Start (React 19, Tailwind 4) with Hono as the top-level `fetch` handler in `apps/web/src/server.ts`. Vite 8, `@cloudflare/vite-plugin`. UI primitives are hand-rolled in `components/ui/` (shadcn deliberately skipped, see `docs/design.md`).
- **Hosting:** one Cloudflare Worker (`wrangler.jsonc`, name `agentum`, env `production`) with custom domains. Bindings: D1 `DB`, R2 `ATTACHMENTS`, Browser Run `BROWSER`, Workers AI `AI`, Worker Loader `LOADER` (dev only), and six SQLite Durable Objects: `ChannelRoom`, `AgentRouter`, `AgentComputer`, `RoutineScheduler`, `AgentRunner`, `ComputerRelay`.
- **DB:** D1 plus Drizzle (`drizzle-orm` 0.45), 26 migrations (0000 to 0025), per-module `schema.ts` files wired by `drizzle.config.ts`. About 40 tables.
- **Auth:** Clerk (`@clerk/hono` middleware, `@clerk/tanstack-react-start`). Members are `workspace_members` rows with role `owner` or `member`. Agents authenticate to the MCP endpoint with a per-agent token in the URL (SHA-256 stored). Computers use a single-use enrollment code, then a hashed bearer credential. Slack requests are checked with the per-app signing secret. Attachment links use an HMAC. Dev login: `GET /api/dev-login` mints a Clerk sign-in token (same pattern as in this repo's CLAUDE.md).
- **AI:** `@anthropic-ai/sdk` ^0.118 (Managed Agents beta, vaults, skills), `@modelcontextprotocol/sdk`, `@hono/mcp`, `@cloudflare/playwright`, `@cloudflare/computer`.
- **Go computer client:** `coder/websocket`, `jezek/xgb`, `x/sys`. Two Docker images (headless busybox, and Debian with Xvfb, openbox, Chromium) published to ghcr by `.github/workflows/computer.yml`. Also built as static binaries for linux and darwin.
- **Deploy:** `bun run prod:deploy` (`CLOUDFLARE_ENV=production vite build && wrangler deploy --env production`). Clerk keys, `ANTHROPIC_API_KEY`, `CONNECTOR_KEY`, `ATTACHMENT_LINK_KEY` and `AI_GATEWAY_ID` are Worker secrets or vars. There is no CI for the web app (only the computer image workflow).
- **Local dev:** `vite dev --port 3720`. Needs `wrangler login` plus `CLOUDFLARE_ACCOUNT_ID` (remote browser and AI bindings), and a public tunnel URL in `PUBLIC_APP_URL`, because Anthropic rejects loopback MCP URLs.

## 3. Module map

All paths under `apps/web/src/` unless noted. Each `modules/<x>/` holds its own `schema.ts`, `service.ts`, `routes.ts` and tests. Modules import each other's service functions, so they are not as isolated as the portable-module rule in Dom's CLAUDE.md wants.

| path | responsibility | notes |
|---|---|---|
| `server.ts` | Hono entry, mounts everything under `/api/w/:workspaceSlug`, re-exports the 6 DO classes | Public (non-Clerk) mounts: `/mcp/:token`, `/api/bridges/slack/:id`, `/api/connectors/oauth` callback, `/api/attachment-links`, `/api/computer-hosts/{connect,enroll}` |
| `modules/workspaces/` | tenancy: workspaces, members, `requireWorkspace` / `requireOwner` middleware, Clerk directory | 404 for both unknown and non-member (no existence oracle). Only 2 roles |
| `modules/agents/` | agent CRUD, MCP token, model overrides, session history and reset | `agents.runtime` (`managed` or `cloudflare`) and `agents.computer` (`cloudflare`, `fly`, `self_hosted`) are fixed at creation |
| `modules/anthropic/` | the only code that imports the Anthropic SDK: `gateway.ts` (`AnthropicGateway`, `SessionGateway`), `vaults.ts`, `skills-gateway.ts`, `service.ts` (register/sync/resync), `workspace-keys.ts`, `events.ts` (event reducer), `system-prompt.ts`, `fast.ts` (Haiku side-decisions) | Beta API isolated behind one interface. Per-workspace Anthropic key, encrypted |
| `modules/router/` | `AgentRouter` DO (one per workspace): turns messages and mentions into wakes, polls sessions, handles custom tool calls, budgets, death notices | `agent-router.ts` is 1400 lines. `addressing.ts` asks Haiku "was this thread reply for me". `loop-guard.ts` rate-limits agent-to-agent wake loops |
| `modules/runner/` | `AgentRunner` DO: own agent loop on Workers AI / AI Gateway, alarm-driven state machine (`step.ts`) | Same MCP tools in-process through `InMemoryTransport`. Cap of 40 model calls per wake |
| `modules/mcp/` | per-agent MCP server at `POST /mcp/:agentToken` (stateless, `StreamableHTTPTransport`) | About 30 tools, see section 4. `server.ts` factory is shared by both runtimes |
| `modules/connectors/` | user-added remote MCP servers: OAuth discovery, dynamic client registration, PKCE, bearer, health, tool list | Credentials go to an Anthropic vault, plus an encrypted management copy in D1 |
| `modules/secrets/` | workspace API keys that agents use without seeing them: `http_request` broker tool and vault mirror | Allowed-host rules in `hosts.ts`, AES-GCM with AAD |
| `modules/computer/` | computer backends (`client.ts`), `ComputerRelay` DO, enrollment, hosts, Fly gateway, desktop capture, viewer hub, take-control lease | Wire contract in `protocol.ts` (Zod, v1, frozen) |
| `modules/browser/` | Cloudflare Browser Run (Playwright) tools for agents, SSRF rules | Sessionless Kitesurf is unusable, uses Chromium |
| `modules/messaging/` | channels, messages, threads, mentions, attachments (R2, up to 100MB), signed attachment links, `ChannelRoom` DO for WebSocket fanout | |
| `modules/bridges/` | Slack bridge: per-agent Slack app via generated manifest, events, interactive buttons, mirror in and out, thinking indicator | Credentials are pasted by the user (bot token and signing secret), not installed by OAuth |
| `modules/routines/` | per-workspace `RoutineScheduler` DO (one alarm), cron / daily / weekly / interval / once schedules with timezone and DST handling | Fires as a normal channel message to the agent |
| `modules/questions/` | `ask_user` / `check_answer`: agent asks a human, answer wakes it. Web and Slack Block Kit cards | First answer wins via conditional UPDATE |
| `modules/wiki/`, `modules/skills/` | markdown wiki with revisions and assets; versioned skills mirrored to the Anthropic Skills API (R2 is the source of truth) | |
| `modules/activity/` | `agent_activity` log: kind, summary, JSON detail, per agent | Kinds: computer.*, browser.*, http.request, wiki.edit, attachment.link. Not append-only enforced, not workspace-wide |
| `components/`, `routes/`, `lib/` | React UI: Slack-like workspace shell, agent rail (Screen, Files, Activity, Profile), connectors, secrets, computers, routines, skills, wiki pages | Routes under `w.$workspaceSlug.*`. `lib/api.ts` is a typed client over `/api/w/:slug` |
| `modules/landing/` | public landing page and newsletter sign-up | |
| `crypto.ts`, `r2.ts`, `db/` | AES-GCM `encryptSecret` / `decryptSecret` (optional AAD), R2 helpers, D1 client | |
| `apps/computer/` (Go) | `agentum-computer` daemon: `cmd/agentum-computer` (`enroll`, `run`, `status`), `internal/{conn,agent,runner,files,policy,audit,desktop,enroll,state,protocol,serverurl}` | Shell, files, Xvfb desktop, screenshots, input, clipboard, allow/deny policy, audit log |
| `apps/web/scripts/` | spikes against live APIs (`anthropic-spike.ts`, `computer-spike.ts`, `browser-spike.ts`), `create-dev-user.ts` | Spikes before building is a repeated habit |
| `docs/` | `plan-*.md` per feature (each pairs with a PROGRESS cycle), `design.md`, `handbook/` HTML deck | |

## 4. Reusable pieces

Effort is rough, for someone who already has a TanStack Start and Cloudflare boilerplate.

| what | exact paths | copy or borrow | effort / fit | brief section |
|---|---|---|---|---|
| Managed Agents gateway: register, sync, create session, poll events, custom tools, vault ids, skills, transcripts, behind one interface | `modules/anthropic/gateway.ts`, `events.ts`, `config.ts`, `system-prompt.ts`, `vaults.ts`, `skills-gateway.ts` | Copy | Low-medium. Hundreds of beta-API facts are already encoded and tested (see section 6). Strip workspace-specific prompt text. The single-interface rule is worth keeping | Creating and running agents; MCP and credentials |
| Wake and session pump: mention to queue to session, budget stops, death notices, session reuse and retire, per-thread model override | `modules/router/*` (`agent-router.ts`, `plan.ts`, `wake-decision.ts`, `loop-guard.ts`, `state.ts`, `custom-tools.ts`), `modules/anthropic/events.ts` | Borrow the pattern, copy small pure files | High to copy whole (1400-line DO tied to messaging and Slack). Pure files (`plan.ts`, `loop-guard.ts`, `wake-decision.ts`, `events.ts`) copy cleanly | Creating and running; Talking |
| `SessionGateway` seam that lets one router drive Managed Agents or a Cloudflare DO loop | `modules/anthropic/gateway.ts` (interface), `modules/runner/{gateway,durable-object,step,tools,ai-model,chat}.ts` | Copy | Medium. Directly serves "choose where it runs". `step.ts` is a pure resumable state machine. A third runtime (remote Claude Code) would be a third `SessionGateway` | Creating and running (runtime choice) |
| Remote computer daemon in Go: outbound WebSocket, enrollment code, exec, file transfer in chunks, policy, audit, Xvfb desktop, screenshot, input, clipboard | `apps/computer/**`, `Dockerfile`, `Dockerfile.desktop`, `packaging/`, `.github/workflows/computer.yml` | Copy whole | Low. Already generic. Brief expects Go connectors. Rename and keep. `README.md` there is also a good security write-up | Creating and running (always-on machine, Docker or native) |
| Relay and protocol: DO per host holding the daemon socket, hibernation API, heartbeat autoresponse, orphan-cancel, lease for human takeover, viewer fanout | `modules/computer/{protocol,relay,remote-client,relay-transport,viewer-hub,desktop-routes,takeover-hook,hosts,enroll-route,connect-route,client}.ts`, `modules/mcp/takeover-tools.ts` | Copy | Medium. Protocol is Zod-typed and frozen, with golden fixtures in `apps/computer/testdata/protocol/`. Coupled to agent rows but the `ComputerBackend` interface is clean | Creating and running; Talking (human takeover) |
| Several agents on one physical machine | none directly | Gap | Agentum maps one container (`computer_hosts` row) to one agent. The Go client already keeps per-session dirs (`<workdir>/<agentId>/`), so multi-agent per host is a small extension | Creating and running |
| Workspace MCP server shared by both runtimes: stateless Streamable HTTP, token in path, tool registry | `modules/mcp/{routes,server,tools,format}.ts`, `modules/agents/mcp-token.ts` | Copy | Low-medium. Matches "connect Claude to the platform via MCP". Today the audience is agents only (tools are scoped to one agent). Dom's own Claude would need a user-token variant, which does not exist | Talking to agents |
| Past-session tools and stored sessions | `modules/mcp/session-tools.ts` (`list_past_sessions`, `read_past_session`), `modules/agents/session-history.ts`, `session-routes.ts`, migration `0025_agent_sessions.sql`, `search_messages` in `mcp/tools.ts` | Borrow | Low. Agentum keeps only a pointer row per Anthropic session and reads the transcript back from Anthropic on demand. Agent-to-agent "ask for an extract" is not built | Talking (stored sessions) |
| Message-based agent inbox (channels, threads, mentions, agent-to-agent posting, ask_user) | `modules/messaging/*`, `modules/questions/*`, `modules/mcp/tools.ts` (`post_message`, `read_channel`, `read_thread`, `ask_user`), `components/workspace/*` | Borrow pattern, copy `questions` | Medium. This is a chat product, closer to a Slack clone than to the forum-style inbox in the brief. Probably too heavy to take whole | Talking (inbox) |
| Connector management: add by URL, probe, OAuth discovery (RFC 9728, 8414), dynamic client registration, PKCE popup, bearer, health, tool cache, assign to many agents | `modules/connectors/{oauth,mcp,url,service,routes,health,usability}.ts`, `components/connectors/*`, `lib/use-connectors.ts`, `modules/agents` (`agent_connectors`) | Copy | Medium. Best-fit piece for "one place, create once, assign to many, multiple auth methods". Hand-rolled probe because the SDK swallows `WWW-Authenticate` | MCP connectors and credentials |
| Anthropic vault as the credential store: one vault per connector or workspace, `mcp_oauth` with refresh block, `static_bearer`, env-var credentials | `modules/anthropic/vaults.ts`, `modules/connectors/service.ts`, `modules/secrets/mirror.ts` | Copy | Low-medium. Keeps refresh out of our code, but only works for the Managed Agents runtime | MCP connectors and credentials (vaults) |
| Secret broker: agent calls `http_request` with a named secret, the value is injected server-side, host allowlist, redaction, SSRF guard on every redirect, activity row without headers | `modules/mcp/secret-tools.ts`, `modules/secrets/{hosts,service,routes,schema,mirror}.ts`, `crypto.ts` (AAD binding), `components/workspace/secret-dialog.tsx` | Copy | Medium. Works on both runtimes. A real answer to "secrets in vaults given to agents". Only workspace-level secrets exist, no per-user or per-task-giver secrets | MCP connectors and credentials |
| Encrypted-at-rest helper with AAD | `crypto.ts` (`encryptSecret`, `decryptSecret`, `generateConnectorKey`) | Copy | Trivial | Credentials |
| Slack per-agent app: manifest generator, event ingest, signature check, mirror, Block Kit cards, interactive endpoint, thinking line, bridge ownership so two bots in one channel do not double-ingest | `modules/bridges/slack/*`, `modules/bridges/{bridges,mirror,refs,events-seen,thinking}.ts`, `components/workspace/agent-slack-panel.tsx`, `lib/slack-wizard.ts` | Copy | Medium-high, tied to the channel model. Adds Slack as a gateway on top of channels. The wizard is manual paste, not OAuth install | Slack, triggers, gateways |
| Routines: scheduler DO with one alarm per workspace, schedule types, DST-safe `nextRun`, run history, agent-managed routines via MCP | `modules/routines/*`, `modules/mcp/routine-tools.ts`, `components/routines/*` | Copy | Low-medium. Fires a message, so it relies on the message-to-wake path | Triggers (cron) |
| Attachments: streaming R2 upload to 100MB, signed expiring links so a third-party API can fetch a file | `modules/messaging/attachment-*.ts`, `routes/attachment-links.ts`, `r2.ts`, `modules/mcp/attachment-tools.ts` | Copy | Low | Files |
| Agent file view and upload through the computer | `components/workspace/agent-files-tab.tsx`, `modules/computer/routes.ts`, `computer_*` tools | Borrow | Low. No Drive, Samba or file-landed triggers exist | Files |
| Skills as versioned bundles mirrored to Anthropic | `modules/skills/*`, `modules/anthropic/{skills-gateway,agent-skills}.ts`, `components/skills/*` | Borrow | Medium. Not named in the brief but useful | Creating agents |
| Wiki with revisions, wiki links, agent read/write tools | `modules/wiki/*`, `components/wiki/*`, `mcp/tools.ts` (`wiki_*`) | Borrow | Medium. Closest thing to the brief's knowledge wiki. It is DB rows, not a file tree with bash commands | Logging and knowledge |
| Activity log pattern | `modules/activity/*`, `agent_activity` table | Borrow | Low. Starting point only: per-agent, no actor or user column, no workspace-level view, no tamper-proofing | Logging and knowledge |
| Multi-tenancy rules | `modules/workspaces/*`, `docs/plan-multi-tenancy.md`, `modules/workspaces/isolation.test.ts` | Borrow the pattern | Low. Lessons on IDOR and scoped accessors are worth reading. Brief says keep permissions minimal, so only the workspace boundary is needed | Auth and permissions |
| Per-workspace Anthropic key | `modules/anthropic/workspace-keys.ts`, `docs/workspace-anthropic-keys-plan.md` | Copy | Low | Creating agents |
| Model catalog and per-thread override | `modules/anthropic/config.ts` (`AVAILABLE_MODELS`), `modules/agents/model-overrides.ts`, `mcp/tools.ts` (`set_model`) | Borrow | Low | Creating agents |
| Dev login | `server.ts` (`/api/dev-login`), `routes/dev-login.tsx`, `scripts/create-dev-user.ts` | Already in Harbourmaster boilerplate | None | Auth |
| Browser tools via Browser Run | `modules/browser/*`, `mcp/tools.ts` (`browser_*`) | Borrow | Low-medium. Only works multi-call with Chromium, needs remote binding in dev | Creating agents |

## 5. Brief coverage

**Creating and running agents.** Mostly solved.
- *Solved:* agent create and edit UI (`components/workspace/agent-dialog.tsx`: name, soul, instructions, model, runtime, computer backend, connectors, skills, secrets). Runtime choice between Claude Managed Agents and Cloudflare (Workers AI or AI Gateway). Remote machine as a computer through a Docker or Podman container (README gives both commands) or a native binary (systemd unit in `packaging/`). Fly Machines backend. The whole thing runs on Cloudflare, and there is no local mode.
- *Partly:* "native or container" is two distribution forms of the same daemon, not a per-agent choice. The daemon exposes a computer to an agent whose loop runs elsewhere. It does not run a Claude Code or Agent SDK process on the machine. One host holds one agent. A Claude Desktop style local-first frontend does not exist.
- *Nothing:* running a local Claude Code instance as the agent, Bruce-style agent loops on the user's machine, third-party runtimes besides the two.

**Talking to agents.** Partly.
- *Solved:* web chat with channels, DMs, threads, mentions, attachments, realtime over WebSocket. Slack mentions and thread replies. Stored sessions, with `list_past_sessions` and `read_past_session` MCP tools. `search_messages` across channels the agent belongs to. `ask_user` with permission gates.
- *Partly:* MCP access exists but only for agents. There is no endpoint with Dom's own credentials that lets Claude say "message Bruce". Agents can post to each other with `post_message` and `@Name`, and `loop-guard.ts` stops runaway chatter, but that is a chat room, not a forum inbox.
- *Nothing:* Claude-to-platform MCP for humans. Agents asking other agents for an extract of an old session (both tools are scoped to `ctx.agent.id`, so an agent only reads its own sessions).

**MCP connectors and credentials.** Strongest area, but one-dimensional.
- *Solved:* one place to create connectors, assign to many agents (`agent_connectors`, 20 per agent cap). OAuth with discovery, dynamic registration and manual client id/secret, PKCE, popup, re-authorize (`beginReauthorization`), bearer token, no auth. Status values include `auth_error` and the UI re-triggers auth. Vault per connector, refresh by Anthropic. Workspace secrets with host allowlists for API-key services.
- *Partly:* "multiple OAuth setups" per server: `connectors` has a unique `(workspace_id, url)`, so two accounts for the same server need two workspaces. Header auth: workspace secrets let `http_request` set a header, but a connector itself only supports OAuth or a single bearer.
- *Nothing:* the three credential cases. Every credential is workspace-level (no `user_id` on `connectors`, `workspace_secrets` has only `set_by_clerk_user_id` for audit). There is no "act as Dom", no "act as the colleague who asked", and no separate agent identity. All of it works only on the Managed Agents runtime (Cloudflare runtime agents get no connectors). In-session credential choice would need vault selection per session, which `sessionVaultIdsFor` (`anthropic/service.ts`) is the right hook for, since `vault_ids` is fixed at session create.

**Slack, triggers and gateways.** Partly.
- *Solved:* per-agent Slack app via generated manifest, events, signature check, mention and channel monitoring, interactive buttons, file mirror up to 20MB, thinking indicator. Routines (cron-like, with timezone). An agent can create its own routines.
- *Partly:* the install is a manual paste of manifest then the bot token and signing secret, not the one-click OAuth install the brief wants. No management-token flow (`apps.manifest.create`) exists, so the wizard stays a paste. A channel can be bridged (agent joins on invite) but proactive "watch every message" depends on the digest mechanism in the router (`DIGEST_INTERVAL_MS`), which I did not run.
- *Nothing:* inbound HTTP trigger with bearer auth, file-landed triggers, any gateway besides Slack.

**Files.** Mostly nothing.
- *Solved:* attachments in chat (100MB), signed links for external APIs, Files tab per agent computer, upload to a remote computer, wiki assets.
- *Nothing:* Google Drive, Meet folders, Samba or Windows shares, OneDrive, triggers on file arrival. (The Go daemon could carry a Samba gateway, nothing exists for it.)

**Logging and knowledge.** Partly.
- *Solved:* `agent_activity` rows for computer, browser, http and wiki actions, shown in the Activity tab. Wiki module with revisions, agent read/write/search tools. Anthropic memory store per managed agent. Local `audit.jsonl` on each computer.
- *Partly:* the log is per agent, covers only some tools, has no actor field and is a normal mutable table. The wiki is a DB tree, not a file structure with bash-style commands.
- *Nothing:* an append-only workspace log designed for pattern learning, and "just-bash" style knowledge filesystem.

**Auth and permissions.** Solved for the first iteration.
- Clerk, workspace membership, two roles (owner or member), owner-only gates for secrets, hosts, keys, channel delete. Tenant isolation tested (`workspaces/isolation.test.ts`). No fine-grained permissions, which matches the brief. Per-agent MCP tokens and host credentials are well designed (hash when inbound, encrypt when outbound).

## 6. Gotchas and lessons

Taken from `PROGRESS.md` and checked where code was nearby. These matter if Harbourmaster reuses the same Anthropic APIs.

**Managed Agents beta traps**
- `mcp_toolset` defaults to `permission_policy: always_ask`, so sessions park in `requires_action` unless `always_allow` is set.
- `vault_ids` and `mcp_servers` are fixed at session create. Changing a connector, a tool list or a skill only reaches the agent's next session. The code retires the session on a tool change and defers connector resync until the agent is idle.
- Vault credential `mcp_server_url` is immutable (changing it means a new credential). `mcp_oauth` refreshes only when a `refresh` block is granted. A vault holds at most 20 credentials. A `networking` update replaces rather than merges. Deleting a vault with live credentials succeeds.
- Environment names are not unique even though the docs say so. The gateway lists then adopts. Archiving agents or stores is permanent.
- MCP tool results that carry images are dropped silently. Screenshots only reach the model through a client-run custom tool (`desktop_screenshot`) whose result the router sends back. Three attempts were needed.
- `session.status_idle` carries a `stop_reason`. Ignoring it hid `budget_reached` kills. Budgets are per session, so session reuse shrinks them. Now $10 and a fresh session per top-level mention.
- `events.list` has no after-id cursor, only `created_at[gte]`, so the cursor is timestamp plus client-side id slicing.
- `agents.create` rejects loopback MCP URLs. Local dev needs a tunnel and `PUBLIC_APP_URL` set to it, or registration fails.
- The SDK's MCP transport swallows the 401 `WWW-Authenticate` header, so the OAuth probe is hand-rolled.
- Skills API downloads fail with workspace keys, so R2 stays the source of truth.
- Anthropic injects vault env-var secrets at egress. The sandbox sees a placeholder, not the key. A grant is per agent but the vault is per workspace, so any grant exposes every secret in the workspace to that agent's sandbox (the UI now says so).

**Design mistakes and limits recorded**
- Fly backend was "built against docs and fakes only", never run on a real account (still stated in `apps/web/README.md`). Podman instructions also come from the plan, not a run.
- A multi-minute `exec` from a managed agent rides in one held-open MCP request, and Anthropic's timeout on that was never verified.
- The deployed Worker has no shell for the Cloudflare computer (Worker Loader is refused in production, error 10021), so the default computer backend there is files only. A shell needs a self-hosted container or Fly.
- Cloudflare-runtime agents have no subagents, sandbox toolset, connectors or `set_model`. They depend on Workers AI response dialects that were only confirmed live for Kimi K2.5.
- Tenancy came late (cycle 8) and needed a rebuild: NOT NULL defaults as a backfill vehicle, `DROP TABLE` cascades, Hono merging nested params (`:slug`), unscoped by-id reads as existence oracles. Put the workspace id in every accessor signature from day one.
- Durable Objects forget in-memory state on eviction (relay viewer list, run meta). Merge onto stored state every time, and never call `publishMessage` from inside the router DO (RPC back into itself).
- Bun and workerd differ on GET with a body and similar edge cases, so security checks must be explicit guards. A passing test can pin the wrong behaviour (the redirect SSRF guard case).
- Known unclosed gap: no DNS resolution in a Worker, so an allowed public hostname that resolves to a private address passes the secret-broker checks. Two copies of the private-range list exist (`secrets/hosts.ts`, `browser/rules.ts`).
- Timestamps are inconsistent across module views (epoch numbers vs ISO strings). One bug came from typing a wire field as string when it was epoch ms.
- Naming collision: the Slack module was first called `connectors`, then renamed `bridges`. Choose terms early.
- Slack manifest gains need a re-apply story for existing apps. Adding a scope also forces reinstall.
- D1 `unixepoch()*1000` defaults are whole-second, so set `createdAt` in JS for ordering.
- Workflow: parallel coding agents in one tree worked once file ownership was explicit. The repo-wide lint hook once forced `--no-verify`.

**Docs and code disagree**
- `apps/web/README.md` still says "no Cloudflare resources are provisioned yet, so `database_id` is a placeholder", lists "three bindings" (there are 11 counting the six Durable Objects) and tells you to run `bun run deploy`. The real script is `prod:deploy`, and `wrangler.jsonc` has a real D1 id and two production domains.
- Root README says the product is on `agentum.rockyshoreslabs.io`. `wrangler.jsonc` also serves `agentumbot.io`.
- `.env.example` suggests `PUBLIC_APP_URL=http://localhost:3000`, but dev runs on 3720 and a public tunnel is required anyway.
- `docs/design.md` is Phase 1 and says Wiki and Screen tabs are "disabled / soon". They exist now. `docs/plan-remote-desktop.md` describes the full plan, while `tasks-remote-desktop.md` is the demo subset that was built. PROGRESS cycle 17 describes `apps/computerd`, which no longer exists (replaced in cycle 19).
- Root `CLAUDE.md` and `AGENTS.md` are generic Bun and Ultracite boilerplate plus the dev login note. They say nothing about the architecture. The knowledge lives in `PROGRESS.md` and `docs/plan-*.md`.
- `apps/computer/README.md` carries a "Ported from the trueforge fork at b3aded57" note and mentions "Code Mode, when it arrives", which is not in this repo.

## 7. Maturity

- **Last commit:** 2026-10-15 (`220741d`), 50 commits since 2026-09-10 on `main`. Several side branches are checked out (`feature/take-control`, `feature/workspace-api-keys` as worktrees).
- **Tests:** 133 web unit test files (`bun test`, PROGRESS reports about 1400 tests as of cycle 18), 7 Playwright e2e specs (`apps/web/e2e`, stub MCP server, dev-login auth), 18 Go test files with golden protocol fixtures. `apps/computer/scripts/test-race.sh` and a desktop image test exist. No CI runs the web tests. The only workflow publishes computer images. I did not run any tests.
- **Deployed:** yes, production Worker on two custom domains with remote D1 and R2. The Managed Agents path and the self-hosted computer with desktop were accepted live. Fly is unverified. Cloudflare computer shell works only in dev.
- **Completeness:** a working product with its own docs and a talk deck (`docs/handbook/`). Its scope is Slack-style team chat with agents, so Harbourmaster's brief overlaps on runtime, connectors, secrets, computers and routines but differs on identity: agent-centric credentials only, no per-user credentials, no human-facing MCP, no inbound triggers beyond Slack, no file gateways.
- **Reuse risk:** the code is heavily coupled to the messaging model (the router wakes agents from channel messages, and routines, questions and Slack all ride on it). The cleanest cut for Harbourmaster is: Go daemon and relay protocol, Anthropic gateway and vaults, connectors, secrets broker and crypto, routines scheduler, and the `SessionGateway` seam. Take the router and Slack bridge as patterns.
