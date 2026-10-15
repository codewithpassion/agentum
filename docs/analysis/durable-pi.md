# Analysis: durable-pi

Repo: `/home/roboto/devel/durable-pi` (remote `git@github.com:codewithpassion/durable-pi.git`). Read-only study, 16 Oct 2026.

## 1. Purpose

Durable Pi is IndyDevDan's demo of a "durable agent network" built on `@earendil-works/pi-durable` 1.0.3, an external, experimental agent harness that commits every model turn, tool call, queued input and app document to SQLite before showing it. Each machine runs `dpi-backend`, a small HTTP + SSE server that owns the agents. Clients (a web hub, a terminal UI, curl) are thin viewers that connect with a URL and a bearer token. A second app, `proactive-dpi-demo`, shows an event stream (mock Cloud Run logs) that starts an incident agent without a human prompt.

Correction to the assumption in the brief: this is not a Cloudflare project. There is no Worker, no Durable Object, no D1 and no wrangler config. Everything is Node 22/24 plus `node:sqlite`, Express 5 and Vue 3. The only Cloudflare link is a docs claim that pi-durable's portable SQLite core can run in a Durable Object behind an async SQLite facade (`ai_docs/durable_pi/readme.md` line 547, `announcement.md` line 82). Nothing in this repo exercises that claim.

The repo is a single-commit snapshot by IndyDevDan (`37165c6`, 2026-10-11, MIT). The remote is Dom's `codewithpassion` copy, so code can be lifted freely.

## 2. Stack and deployment

| Area | What is used |
|---|---|
| Language / runtime | TypeScript on Node 24 (`.nvmrc`; `engines` `>=22.19`), run with `tsx`. No Bun. `node:sqlite` `DatabaseSync` for the catalog, which is Node-only |
| Agent engine | `@earendil-works/pi-durable` 1.0.3 (harness, tasks, docs, extensions), `@earendil-works/pi-ai` 1.0.3 (model access), `@earendil-works/chord` 1.0.3 (document state). All three are pinned and not vendored |
| Models | OpenRouter only (`OPENROUTER_API_KEY`), curated list in `apps/dpi-backend/src/model-catalog.ts`. `DPI_PROVIDER=faux` gives a deterministic offline model for tests |
| HTTP | Express 5. One device server on port 4780, one hub on 127.0.0.1:4781 |
| Frontends | Vue 3.5 + Vite 8 (hub client, proactive demo UI), `@earendil-works/pi-tui` terminal client |
| Storage | One `sessions/<uuid>/agent.sqlite` per session (pi-durable), `catalog.sqlite` per device (sessions, agent names, idempotency keys, compaction settings), `app-state.sqlite` (shared JSON doc), `~/.dpi/network.sqlite` on the operator's laptop (device URLs and tokens). PID lock files enforce one owner process per database |
| Auth | One static bearer token per device (`DPI_TOKEN`, 32+ chars, constant-time compare in `auth.ts`). No users, no roles, no Clerk. The hub has no login and holds every token |
| Hosting | The operator's own machines. `just net up <id>` provisions launchd/systemd services over ssh or creates exe.dev VMs. Not a managed or multi-tenant host |
| Ops tooling | `just` modules under `just/`, `dpi-network.yaml` (gitignored), TypeScript ops CLI `apps/dpi-sdk/scripts/net.ts` |
| Tests | `node:test` via `tsx --test`, Playwright-style `.mjs` UI and e2e scripts |

## 3. Module map

| Path | Responsibility | Notes |
|---|---|---|
| `apps/dpi-backend/src/main.ts` | Express boot, `/healthz`, mounts `/v1` behind `bearerAuth` | 47 lines |
| `.../src/store.ts` (1191 lines) | `Store`: session catalog, harness lifecycle (`openAgent`), agents, forks, send, abort, compaction, tasks, inbox, usage, idempotency | The core. Mixes catalog SQL, harness wiring and API shaping in one class |
| `.../src/routes.ts` | Thin `/v1` router over `Store` | |
| `.../src/streams.ts` | SSE at device, session and agent scope. `hello` then snapshot then deltas. `coalesce()` throttle, 2 MB slow-viewer cutoff | Never replays. Reconnect gets a fresh snapshot |
| `.../src/extensions.ts` | The "playground" extension: tools `read_state`, `update_state`, `list_durable_jobs`, `run_durable_job`, `check_durable_job`, `search_history`, `ping_on_call_engineer`, `subagent`, `start_session`, `handoff` | Tool definitions with `replay: "safe"` flags. Good examples of crash-safe tools |
| `.../src/addons.ts` | Optional extensions `system-prompts` (prompt checklist doc) and `jev-damage-control` (`beforeTool` hook that blocks `bash`) | Per-agent toggle via PATCH `/extensions` |
| `.../src/jobs.ts` (790 lines) | Durable jobs: named phases, checkpoints, approval task `demo.job-approval`, records in doc `demo.job-runs` | Three example jobs. Approval waits for a person, survives restart |
| `.../src/shared-state.ts` | `SharedState`: device-wide JSON doc with revision, path ops and receipt keys for idempotent changes | Own harness on `app-state.sqlite` |
| `.../src/history.ts` | `searchHistory()`: pure search over all stored entries, labels each hit `active`, `compacted` or `before reset` | Backs the `search_history` tool. Directly relevant to "agents look back at their sessions" |
| `.../src/idempotency.ts`, `errors.ts`, `auth.ts`, `config.ts` | `Idempotency-Key` replay, error envelope `{error:{code,message}}`, bearer check, `backend.env` loader | Small and clean |
| `.../src/jev.ts`, `faux.ts`, `model-catalog.ts` | Jev (TypeSafe) classifier client, offline faux model, OpenRouter model list | Jev is a paid third-party API |
| `.../API.md`, `README.md` | Full v1 route table, SSE frames, recipes | Accurate against `routes.ts`/`store.ts` as far as checked |
| `apps/dpi-sdk/src/api.ts` | Wire contract types (`DeviceTree`, `SessionSummary`, `AgentSummary`, `SendResult`, `Frame`, `MuxFrame`) | No runtime deps. Runs in browsers |
| `.../src/client.ts` | `DpiClient`, `SessionHandle`, `AgentHandle`, `follow()` (reconnecting stream) | Typed REST client. `agent.send(content, whenBusy, requestId, waitMs)` |
| `.../src/models.ts`, `transcript.ts`, `sse.ts` | `AgentModel`, `SessionModel`, `NetworkModel` reducers, transcript items, fetch-based SSE reader | "One reducer, two renderers" |
| `.../src/node/registry.ts`, `config.ts`, `drivers.ts`, `ops.ts` | Device registry (SQLite), YAML parser, per-kind drivers (`local`, `ssh`, `exe-dev`, `url`) | Operator tooling for a fleet of machines |
| `apps/dpi-playground/apps/dpi-playground-hub/src/` | `guard.ts` (Host/Origin/JSON checks), `proxy.ts` (token-injecting REST proxy), `mux.ts` (one SSE per tab fanning out to device streams), `monitor.ts` (online/offline/unauthorized/mismatch/incompatible), `seed.ts` | Browser never sees tokens |
| `apps/dpi-playground/apps/dpi-playground-fe/src/` | Vue client: network tree, agent view, composer (followUp/steer/reject), inspector tabs (Session, State, Tasks, Tools, Extend) | `components/StateEditor.vue`, `JobCard.vue`, `Composer.vue`, `Inspector.vue` |
| `apps/dpi-tui/src/` | Terminal client (1123 lines) on pi-tui | Same models as the web client |
| `apps/proactive-dpi-demo/apps/proactive-dpi-be/src/` | `watcher.ts` (Jev verdicts, fingerprints, thresholds), `ops.ts` (atomic incident open, restart recovery), `extensions.ts` (`ops.deploy` approval task, ops tools, git guard hook), `voice.ts` (ElevenLabs) | The only event-to-agent trigger in the repo. Mock data source |
| `apps/proactive-dpi-demo/apps/proactive-dpi-logs/` | Fake Cloud Run log generator and "deploy" simulator | Demo scaffolding |
| `.claude/commands/{install,prime}.md`, `.claude/skills/agent-sandboxes-exe-dev/` | Claude Code setup commands and an exe.dev VM skill (Python CLI) | Not product code |
| `ai_docs/` | Snapshots of pi and pi-durable docs, including the 4696-line `durable_pi/spec.md` | Best written description of pi-durable's model |

## 4. Reusable pieces

| What | Exact paths | Copy code or borrow pattern | Effort / fit | Brief section |
|---|---|---|---|---|
| Durable agent harness (the engine itself) | npm `@earendil-works/pi-durable`, `pi-ai`, `chord` (docs in `ai_docs/durable_pi/readme.md`) | Depend on it, do not copy | Runs on Node/Bun today. DO/Workers use needs an async SQLite adapter that nobody here has written. Experimental, API "changes without notice". Biggest decision for the architect | Creating and running agents |
| Idempotent message API with wait | `apps/dpi-backend/src/routes.ts`, `store.ts` `send()`/`settled()`, `API.md` | Borrow the pattern, copy `SendResult` shape | `POST .../messages {content, whenBusy, requestId, waitMs}` returns `done` + answer, or `pending`/`queued`, then long-poll `GET /submissions/:id?waitMs=`. Ideal for "Claude, message Bruce" over MCP and for webhook triggers | Talking to agents, Triggers |
| Idempotency-Key replay middleware | `apps/dpi-backend/src/idempotency.ts` plus `requests` table in `store.ts` | Copy (about 20 lines) | Easy. Swap `node:sqlite` for D1 or DO storage | Creating agents, Triggers |
| Typed wire contract + client | `apps/dpi-sdk/src/api.ts`, `client.ts`, `errors.ts`, `sse.ts` | Copy | No runtime deps, browser-safe, fits Bun/Workers. Rewrite the routes to match Harbourmaster | Talking to agents |
| Stream reducers (SSE frames to view state) | `apps/dpi-sdk/src/models.ts`, `transcript.ts`, `sse.ts` | Copy | `AgentModel` is tied to pi-durable's `watchEvents` event shapes. Reuse only if pi-durable is the engine. Otherwise borrow the snapshot-then-delta pattern | Talking to agents |
| SSE stream server pattern | `apps/dpi-backend/src/streams.ts` (`openSse`, `coalesce`, 15 s ping, 2 MB cutoff, `sendIfChanged`) | Copy | Express types; port to Hono `streamSSE` or DO WebSockets. Logic is portable | Talking to agents |
| Session search / look-back | `apps/dpi-backend/src/history.ts`, tool `search_history` in `extensions.ts` | Copy `searchHistory()` | Pure function over `WireEntry[]`. Tied to pi-durable entry kinds (`pi.user`, `pi.assistant`, `pi.tool-result`, `pi.reset`, `pi.compaction`). Pagination and snippet logic reusable | Talking to agents (sessions stored, agents read old sessions) |
| Agent-to-agent spawn and delegate | `extensions.ts` tools `subagent`, `start_session`; `store.ts` `spawnSession()` and `session_spawns` table | Borrow pattern | Spawn key = `start_session:<session>:<taskId>`, stored in the same transaction as the new session, first prompt reuses `requestId`. This is the correct crash-safe spawn recipe | Creating and running agents, inbox |
| Shared state doc with revisions and receipts | `apps/dpi-backend/src/shared-state.ts`, `apps/dpi-sdk/src/app-state.ts`, `StateEditor.vue` | Borrow pattern | Atomic path ops, `409 conflict` on stale revision, receipt key per change. Fits a small shared blackboard. Not an inbox | Logging and knowledge (blackboard only) |
| Durable approval / human-in-the-loop task | `apps/dpi-backend/src/jobs.ts` (`demo.job-approval`), `apps/proactive-dpi-demo/.../extensions.ts` (`ops.deploy`) | Borrow pattern | Tool call owns a task that waits on a document field until a person decides. Survives restart, no duplicates. Good template for "agent asks permission" | Auth and permissions (approvals), Triggers |
| Event-to-agent trigger (cheap classifier + thresholds + agent) | `apps/proactive-dpi-demo/.../watcher.ts`, `ops.ts` | Borrow pattern | Code owns thresholds, classifier owns judgment, agent does open-ended work. One commit opens the incident and creates the conversation. Resubmits briefs with request ids on restart. Mock source only | Slack/triggers/gateways |
| Pre-tool guard hook | `addons.ts` (`jev-damage-control`), `proactive-dpi-be/src/extensions.ts` (git guard `beforeTool`) | Borrow pattern | `hook(ToolTask, {beforeTool})` returning `{block}`. Verdict stored as a durable memo so a restart does not re-ask. Good hook point for permissions and audit | Auth and permissions, Logging |
| Per-agent runtime config (model, thinking, read-only, extensions) applied from next request | `store.ts` `configure()`, `setExtension()`, `WRITE_TOOLS` | Borrow pattern | "Read only" removes write tools from the next request. Useful for a minimal permission switch | Auth and permissions |
| Bearer-token auth middleware | `apps/dpi-backend/src/auth.ts` | Copy | Fine for bearer-token trigger endpoints. Not a user system | Triggers (API endpoint with bearer auth) |
| Hub: token-injecting proxy, mux, Host/Origin guard | `apps/dpi-playground/apps/dpi-playground-hub/src/{proxy,mux,guard,monitor}.ts` | Borrow pattern | Shows how one UI fronts many agent hosts without exposing tokens. Relevant if Harbourmaster's control plane reaches self-hosted machines. Device health states (`online`, `unauthorized`, `mismatch`, `incompatible`) are worth copying | Creating and running agents (remote machines) |
| Device fleet registry and provisioning drivers | `apps/dpi-sdk/src/node/{registry,config,drivers,ops}.ts`, `dpi-network.example.yaml`, `just/net/mod.just` | Copy or borrow | Declarative YAML to launchd/systemd/exe.dev provisioning, `deploy`, `rotate`, `logs`. Covers "always-on remote machine" provisioning. Native process only, no Docker/Podman | Creating and running agents (real machines) |
| Service unit templates | `apps/dpi-backend/deploy/{dpi-backend.service,dpi-backend.plist,backend.env.example}` | Copy | Ready launchd and systemd units | Creating and running agents |
| Faux provider for tests | `apps/dpi-backend/src/faux.ts`, `tests/helpers.ts` | Copy pattern | Deterministic, free, scripted prompts (`!cmd`, `job:`). Makes e2e and crash tests cheap | all |
| Crash-recovery test | `apps/dpi-backend/tests/recovery.test.ts` | Copy pattern | SIGKILL mid-job, restart, assert resumed once | all |
| Web client layout (tree, transcript, composer with steer/follow-up/reject) | `apps/dpi-playground/apps/dpi-playground-fe/src/` | Borrow UI ideas | Vue, not React/shadcn. Harbourmaster stack differs, so only the interaction design transfers | Creating and running agents (frontend) |

## 5. Brief coverage

**Creating and running agents.** Partly solves.
- Solves: a session API (`POST /v1/sessions {name, cwd, model, thinkingLevel}`), forks at any entry, subagents, agent-started sessions (`start_session`), per-agent config applied on the next request, archive (not delete) of sessions, a catalog of sessions per device.
- Solves: running on real machines. `dpi-network.yaml` plus `just net up` provisions `local`, `ssh` (launchd or systemd) and `exe-dev` devices, with deploy, rotate and logs. Several agents share one machine as separate sessions, each with its own `cwd` and SQLite file.
- Does not solve: running as a Cloudflare agent (nothing here is Workers code), running on Claude managed agents, Docker or Podman containers (pi-durable supports a custom `ExecutionEnv` per conversation, example `29-sandbox-per-conversation`, but this repo only uses `NodeExecutionEnv`), per-agent OS users, or a "create agent" form. The web client has a New Session dialog (`NewSessionDialog.vue`) that picks device, folder and model, which is close to a minimal creator.
- Agents are coding agents bound to a folder. There is no agent definition (role, prompt, connectors) stored as reusable config beyond the `system-prompts` checklist and `instructions` field in `configure()`.

**Talking to agents.** Mostly solves, for its own agents.
- One HTTP API, three clients. `whenBusy` is `followUp`, `steer` or `reject`. Sends are idempotent by `requestId`. Streams are viewers only.
- Sessions are stored in full. `GET .../entries` pages through all history. `GET .../transcript?format=markdown` exports it. `search_history` lets an agent search its own history, including text before resets and compaction.
- Does not solve: connecting Claude via MCP (the repo exposes REST, not an MCP server. `grep` for MCP in `apps/` finds nothing), one agent asking another for an extract of an old session (an agent can only search its own history; reading another session needs a new tool over the REST API), the forum-style inbox. The only inter-agent channels are `start_session` (spawn with a first prompt), `subagent` (owned child) and the device-wide App State doc. The "inbox" in the code (`pi.inbox`, `InboxItem`) is the queue of pending user inputs for one agent, not a message board.

**MCP connectors and credentials.** Nothing.
- No MCP client, no connector registry, no OAuth, no vault. `ai_docs/pi/mcp.md` documents MCP support in the separate pi coding agent (stdio and streamable HTTP, `~/.pi/agent/mcp.json`, bearer env var, sign-in via `/mcp`), but dpi-backend does not wire it in. Tools are code-defined (`defineTool`) and fixed per extension.
- Secrets: `OPENROUTER_API_KEY` and `TYPESAFE_API_KEY` are copied from the operator's `.env` into each device's `backend.env` (mode 0600) and never sent to clients. That is the whole secret story. No per-user or per-agent credentials. The bash tool gets a stripped env (`PATH HOME USER SHELL TMPDIR LANG TERM`, see `openAgent`), which is a useful detail for keeping secrets out of agent shells.

**Slack, triggers, gateways.** Partly solves triggers, nothing for Slack.
- Solves: the concept of event-started agents. `proactive-dpi-demo` polls a log store, classifies rows, applies thresholds in code and opens an agent in one atomic commit. External callers can start work with a bearer-token `POST .../messages` (the curl one-shot). Idempotent by `requestId`, so webhook retries are safe.
- Does not solve: Slack of any kind (no mention of Slack, OAuth or thread mapping in code), cron or routines (the only timed behaviour is job-internal intervals such as `change-watch`; `grep` finds no scheduler), file-landing triggers, a trigger registry or per-trigger bearer tokens. The device token is also the trigger token, and it grants a full shell.

**Files.** Nothing beyond the local filesystem.
- Agents read and write files in the session `cwd` through the pi coding tools. `GET /v1/fs/dirs` browses folders on the device. There is no upload API, Slack upload, Drive, Samba or file-triggered agent.

**Logging and knowledge.** Partly solves logging, nothing for a wiki.
- Everything an agent does is stored as immutable entries in its `agent.sqlite`, and tool tasks keep checkpoints. That is a complete per-session audit trail, queryable with `entries` and `search_history`. Usage and cost are tracked per model and tool (`Store.usage()`, shown in the session stream and summary).
- It is per-session and per-device. There is no cross-agent append-only log, no cross-session query, no pattern learning, and no shared file-structure wiki. The App State doc is a single JSON blackboard, not a knowledge base.

**Auth and permissions.** Minimal, and not Clerk.
- One static bearer token per device with constant-time compare. The hub has none, and relies on Host, Origin and JSON-only checks plus binding to 127.0.0.1.
- Permissions: one switch, `readOnly`, which removes write tools. `beforeTool` hooks can block individual tool calls. No users, no per-user credentials, no tenant boundary. README states plainly that a token is a shell.
- The approval-task pattern is the only human-gating mechanism, and it is good.

## 6. Gotchas and lessons

Taken from the README "Where it can still fail", `API.md`, `backend/README.md` and the code.

- Durable is not exactly-once. A `requestId` is admitted once, but an external side effect that happened just before a crash may repeat for `replay: "safe"` tools. Unsafe tools (for example `bash` cut off by a restart) come back as an interrupted result so the agent decides. Effects need their own idempotency. `start_session` handles this by storing the spawn key in the same transaction as the new row.
- One process owns a storage at a time and pi-durable has no cross-process locking. The repo adds PID lock files (`lockFile()` in `store.ts`) next to every database. In a Workers/DO design the single-writer rule maps to one DO per session, which is a natural fit, but it is unproven here.
- Streams never replay. A reconnect starts from a fresh snapshot, and a viewer that falls 2 MB behind is cut off. Clients must treat 45 s of silence as dead. This kept the protocol simple and is worth keeping.
- Sessions are archived, not deleted. `DELETE /sessions/:s` aborts work and moves files to `archive/`.
- pi-durable is "experimental" and its "API changes without notice". The repo pins 1.0.3 and carries a `contract-check.ts` that type-checks the pi-durable to SDK wire shapes. Expect churn if Harbourmaster depends on it.
- `store.ts` is a 1191-line class mixing catalog SQL, harness wiring and API shaping. Do not copy it whole. Extract `send/settled`, `spawnSession`, `configure` and the catalog schema instead.
- Demo code is mixed into the product API: routes `.../demo/state`, `.../demo/jobs`, doc kinds `demo.job-runs` and `demo.workspace`, `ping_on_call_engineer`. A reuse should strip the `demo` prefix and the example jobs.
- Security caveats recorded by the author: LAN ssh devices speak plain HTTP, so tokens cross the LAN in cleartext. exe.dev devices are public behind HTTPS with the token as the only gate. The hub holds every token and must stay on 127.0.0.1. `jev-damage-control` fails open and is "a guard, not a sandbox". The proactive demo has no login and runs agent `bash` unsandboxed. macOS devices need auto-login and Full Disk Access for unattended runs.
- Jev is a paid third-party classifier (TypeSafe, or via OpenRouter `~typesafe/jev-latest`). Replacing it with any small model call is easy because it sits behind `askJev()`.
- The model catalog and model ids in `model-catalog.ts` are a dated snapshot (retrieved 2026-10-05) and throw at boot if OpenRouter drops one (`OpenRouter catalog missing <id>`). That is brittle for production.
- Docs and code: I found no contradiction on the API surface. Small drift: the README says `just install` installs "the four network apps" while the proactive demo needs its own `just proactive install`, and `engines` says Node `>=22.19` while the README says Node 24. The README's test counts (SDK 14, backend 10, hub 1, TUI 8) are close to the counts of test blocks in the files, but I did not run them (read-only rules).
- `apps/dpi-playground/package-lock.json` shows as modified in git status and `.env` plus a populated `~/.dpi` exist, so the author or Dom has run it locally. I did not read `.env`.

## 7. Maturity

- Last commit: 2026-10-11 ("🚀"), the only commit, author IndyDevDan. The repo is a published demo snapshot, not a project with history, so there are no progress logs or incident notes to mine.
- Tests: yes. `node:test` suites in `apps/dpi-backend/tests` (api, streams, store, history, shared-state, SIGKILL recovery), `apps/dpi-sdk/tests` (registry, sse, app-state, compaction, config, models), `apps/dpi-tui/tests`, one hub test, plus browser and e2e scripts (`apps/dpi-playground/tests/*.mjs`, `apps/dpi-tui/tests/smoke.sh`). The README reports 28 of 28 faux-device UI checks, 18 of 18 on a cloud VM, and an e2e on an ssh Mac. These are the author's claims. I did not run anything.
- Deployed: designed for personal devices. It ships service files and a provisioning flow, but there is no hosted instance and no multi-tenant story.
- Completeness: complete as a single-user demo of durable coding agents on your own machines. For Harbourmaster's brief it covers the "talk to agents", "sessions stored" and "fleet of machines" parts well, gives patterns for approvals and event triggers, and has no answer for MCP, credentials, Slack, files, wiki or user auth. The biggest open question for the architect is whether to build on pi-durable (gets crash-safe agents and the whole API shape, but is Node-first, experimental and unproven on Workers) or to borrow only the API and pattern design onto Cloudflare Agents or Durable Objects directly.
