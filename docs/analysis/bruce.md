---
type: "analysis"
title: "Analysis: bruce-next and bruce"
tags: ["harbourmaster","bruce","analysis","agent-sdk","slack"]
visibility: "private"
---

# Analysis: bruce-next and bruce

Repos read: `/home/roboto/devel/bruce-next` (primary) and `/home/roboto/devel/bruce`. Read-only, checked against code. One exception to note: I ran `bun test` in `bruce-next/runtime` to get the test count (669 pass, 1 skip, 0 fail). `git status` was clean afterwards.

## 1. Purpose

Both repos are the same product, Bruce: a chat assistant that runs Claude Code inside Slack (and Discord) threads, with a workspace of skills and Bun scripts that gives it capabilities (email, YouTube, LinkedIn, meetings, Google Drive, scheduling). Neither is "Claude Code vs Agent SDK". Both drive the Claude Code engine through `@anthropic-ai/claude-agent-sdk` `query()` with the `claude_code` system prompt preset. The "pure Claude Code" half is the `agent/` workspace itself, which Dom also opens interactively with `claude` (and `claude -p` from scripts).

`bruce` is the original, standalone repo (Mar to Sep 2026). Its `agent/` is the workspace, and `agent/service/` is a small home-grown gateway (Mattermost first, then Slack, Discord, WhatsApp, an optional Agentfield hook). `bruce-next` is the merge: `agent/` copied over from `bruce`, `agent/service/` deleted, and `runtime/` added. `runtime/` is "bruce-reborn", a TypeScript port of the Python Hermes gateway (Nous Research), with much more machinery: SQLite sessions, pairing, profiles, scheduler, memory, CLI, systemd install. `bruce-next` is the one to read for Harbourmaster. `bruce` has moved on in the workspace (meetings pipeline, tmux launcher) and is the only place with Slack's new "agent view" streaming.

Other siblings (one line each): `bruce-2` is an older Mattermost-era monorepo (`bruce-api-lib`, `bruce-cli`, `playground`, last commit 2026-03-02). `bruce-clean` is a one-commit cleanup of `agent/` (2026-03-12). `bruce-hermes` and `bruce-hermes-2` hold `bruce-reborn` plus the read-only Hermes reference, which became `bruce-next/runtime`.

## 2. Stack and deployment

| Aspect | bruce-next | bruce |
|---|---|---|
| Language and runtime | TypeScript on Bun, strict, no `any`. Bun workspaces: `runtime`, `agent/execution` | Same. `agent/service` and `agent/execution` are separate Bun packages |
| Agent engine | `@anthropic-ai/claude-agent-sdk` pinned to `0.2.119`, `@anthropic-ai/sdk ^0.104` for the Memory Stores beta | `@anthropic-ai/claude-agent-sdk ^0.1.0` |
| Chat platforms | Slack (`@slack/bolt ^5.1`, Socket Mode only, multi-workspace), Discord (`discord.js 14`) | Slack, Discord, Mattermost, WhatsApp (webhook), via `service/channels/*` |
| State | `bun:sqlite` with FTS5, schema v7, in `<home>/data/bruce.db`. Optional JSONL transcripts | Flat JSON files: `data/sessions.json`, `data/scheduler/schedules.json`, `data/tasks/tasks.json` |
| Config | `runtime/config.yaml` (Zod schema, `${VAR}` substitution) plus `agent/.env` | Only `.env` (a long list of `SLACK_*`, `MATTERMOST_*`, `AGENT_*` keys) |
| Hosting | Always-on Linux box, native process. `bruce gateway install` writes a user systemd unit (or launchd on macOS) | Native system service via `setup-service.sh` (`/etc/systemd/system/<name>.service`, service `bruce-bot`) |
| Container | `runtime/Dockerfile` exists but is stale and does not build (GAPS 2.35) | None |
| Auth to the agent | `ANTHROPIC_API_KEY` in env. Chat users gated by a pairing code, owners listed in `owner_user_ids` | Slack channel/DM policy env vars and rate limits. No pairing |
| Cloud DB | None. Optional Anthropic Memory Stores (cloud) for long-term memory | None |

The docs say "Claude Code SDK" in `bruce/agent/README.md`. The code is the same Agent SDK. Not a conflict, only an old name.

## 3. Module map

### bruce-next

| Path | Responsibility | Notes |
|---|---|---|
| `runtime/src/core/agent.ts` | `Agent.processTurn()` wraps SDK `query()`. Persists messages, resume ids, token budget, compression | The core. `queryFn` is injectable, so tests never hit the network |
| `runtime/src/core/tools.ts` | In-process MCP server `bruce` via `createSdkMcpServer`: `memory_save`, `memory_recall`, `memory_read`, `send_message`, `delegate` | Pattern to copy for "agent-to-agent" tools |
| `runtime/src/core/mcp_config.ts` | Loads `.mcp.json` from the workspace, merges with the in-process server | Stdio servers only. `type: sse/http` throws |
| `runtime/src/core/env.ts` | Builds the env for the agent process. Strips `CLAUDECODE`, `SLACK_*`, `DISCORD_*` | Keeps platform tokens away from the agent. Does not strip other secrets in `agent/.env` |
| `runtime/src/core/prompt_builder.ts` | System prompt append: parent inheritance, personality, skills, session context, channel prompt, footer | Appended to the `claude_code` preset |
| `runtime/src/core/compressor.ts` | Summarise old messages into one row, archive the rest | Trigger from token budget |
| `runtime/src/gateway/runner.ts` | Platform-agnostic inbound loop: pairing gate, session lookup, streaming delivery | 457 lines |
| `runtime/src/gateway/platforms/{base,slack,discord,mock}.ts` | `Channel` interface and adapters | `base.ts` is the clean contract. `slack.ts` 1133 lines |
| `runtime/src/gateway/delivery.ts` | Streamed edit-in-place replies, splitting, `[ATTACHMENT:path]` extraction and upload | Single choke point for all outbound text |
| `runtime/src/gateway/inbox.ts` | File-drop queue (`~/.bruce/inbox/*.json`), polled every 1 s. Kinds: `outbound`, `inbound`, `cron-trigger`, `schedule-trigger`, `task-trigger` | How the CLI and scripts talk to the live gateway |
| `runtime/src/gateway/pairing.ts` | Hermes-style 8-char pairing codes, rate limits, lockout, file store at `~/.bruce/pairing/` | |
| `runtime/src/gateway/{lock,channel_directory,mirror,hooks,hooks_loader,state_dump,commands}.ts` | Scope lock per bot token, channel name resolution, transcript mirroring, hook bus plus file hooks, `bruce status` dump, slash commands | |
| `runtime/src/state/{db,sessions,memory,jsonl,reset_daemon}.ts` | SQLite schema and migrations, session CRUD, FTS5 search, idle/daily reset | Sessions keyed `(platform, chat, thread)` |
| `runtime/src/cron/` | Static YAML `cron.jobs`, 5-field matcher, `cron_runs` ledger | One reused session per job |
| `runtime/src/scheduler/`, `runtime/src/tasks/` | Chat-created schedules and `{{param}}` tasks stored as JSON under `agent/data/` | tz-aware, hot reload, fresh session per fire, 60 min abort |
| `runtime/src/memory/` | Remote memory (Anthropic Memory Stores) mirror with FTS5 and offline queue, episodic digester, dream pipeline | Optional, off by default. Data leaves the machine when on |
| `runtime/src/config/{schema,load,paths,profiles,wrapper,personalities,models}.ts` | Zod config, loader, path resolution, profiles, `~/.local/bin/<name>` wrapper scripts, personality hot reload | `paths.ts` is the single source of filesystem paths |
| `runtime/src/cli/{bruce,gateway,gateway_service,init,repl,memory_cmd,profile_bootstrap}.ts` | The `bruce` CLI: `gateway`, `repl`, `send`, `new`, `mirror`, `pair`, `status`, `hooks`, `cron`, `schedule`, `task`, `memory`, `profile`, `personality`, `mcp`, `init` | `bruce.ts` is 1704 lines. `bun build --compile` makes a single binary |
| `agent/CLAUDE.md`, `agent/.claude/skills/*/SKILL.md` (about 60) | The 3-layer model: skills say what to do, Claude decides, scripts execute | Skills: setup-slack-bot, manage-schedules, manage-tasks, gws-*, hyperframes, linkedin, transcription |
| `agent/execution/<domain>/*.ts` | Deterministic Bun scripts: email, gdrive, calendar, scheduler, tasks, slack, transcription, youtube, images | `scheduler/` and `tasks/` share JSON shapes with `runtime/src/scheduler` |
| `agent/schemas/` | `data-model.ts`, `db-schema.ts` | Shared types for scripts |
| `agent/.env`, `runtime/.env` | Secrets (gitignored, not read for this report) | |
| `runtime/docs/` | Design notes for remote memory and dreaming | |

### bruce (what is different)

| Path | Responsibility | Notes |
|---|---|---|
| `agent/service/gateway.ts` | 250-line orchestrator: builds channels from env vars, one `AgentHandler`, scheduler, task store, optional Agentfield | Adding a channel is one file plus one `if` |
| `agent/service/lib/agent_handler.ts` | SDK `query()` with `resume`, session store, path and command block lists, progress callbacks | The block lists are advisory regexes, not a sandbox |
| `agent/service/lib/session_store.ts` | In-memory and file-backed session map, 30 day persistence, 30 min idle | Stores only the Claude session id per channel/thread |
| `agent/service/channels/slack/{channel,agent_stream,md_to_mrkdwn,client,config}.ts` | Slack adapter with Slack's agent view: `agents.sessions.setStatus`, streamed answer via `chat.startStream`/`appendStream`, live task plan per tool call, stop button (`agent_session_stopped`) | Not present in `bruce-next/runtime` |
| `agent/service/channels/{mattermost,discord,whatsapp,shared}/` | Other adapters. `shared/` has the router (chat modes, rate limit), splitter, Haiku "quick ack" | WhatsApp adapter has a webhook server |
| `agent/service/scheduler/`, `tasks/` | The original file-backed scheduler and task runner that `runtime/` re-implemented | Same JSON shapes |
| `agent/service/agentfield/` | Optional registration with an Agentfield control plane | Unrelated to Harbourmaster unless Dom wants it |
| `agent/execution/slack/{make_manifest,resolve}.ts` | Generates a Slack app manifest from a bot name, resolves channel and user names to ids | Also in `bruce-next` |
| `agent/execution/meetings/`, `execution/tmux/launch_claude.ts` | Plaud, Granola and Meet sync into The Brain. Launch `claude-yolo` in tmux | `meetings` and `tmux` are newer than the merge and missing from `bruce-next` |
| `agent/.claude/skills/` | About 55 skills, mostly the same | `bruce` has `launch-claude-session`, `grab`. `bruce-next` has `gws-*`, `agent-browser` |

## 4. Reusable pieces

| What | Exact paths | Copy or borrow | Effort and fit | Brief section |
|---|---|---|---|---|
| Agent run wrapper around SDK `query()` (preset prompt, `cwd`, `resume`, `settingSources`, `abortController`, MCP merge, env scrub) | `bruce-next/runtime/src/core/agent.ts`, `core/env.ts` | Copy the code | Low. Strip the memory and budget parts to start. `queryFn` injection is worth keeping. This is the "always-on machine, native" runner | Creating and running agents |
| `Channel` interface and platform-agnostic runner | `runtime/src/gateway/platforms/base.ts`, `gateway/runner.ts`, `gateway/session_router.ts` | Copy `base.ts`, borrow the runner | Low for `base.ts`. Runner is tied to the SQLite and pairing modules | Slack, triggers, gateways |
| Slack Socket Mode adapter (Bolt 5): threads, mentions, slash command, files in and out, edit-in-place streaming, rate-limit retry, multi-workspace | `runtime/src/gateway/platforms/slack.ts` (plus `splitForSlack`, `files.uploadV2`) | Copy the code | Medium. Big file, depends on `base.ts` and hooks. Socket Mode means no public URL, which suits a machine behind NAT. Cloudflare-hosted Harbourmaster needs an HTTP receiver instead (not built here, GAPS section 1) | Slack, triggers, gateways |
| Slack agent view streaming (processing status, task plan per tool call, stop button) | `bruce/agent/service/channels/slack/agent_stream.ts` and its test, plus manifest in `bruce/agent/execution/slack/lib/manifest.ts` | Copy the code | Low to medium. Self-contained 195 lines. Needs a paid Slack plan, falls back to plain messages | Talking to agents |
| Slack manifest generator and name-based setup flow | `agent/execution/slack/{make_manifest.ts,resolve.ts,lib/manifest.ts}`, `agent/.claude/skills/setup-slack-bot/SKILL.md` | Copy the code | Low. This is the closest thing to the brief's "guide me through the Slack install". It still needs 3 manual steps: paste manifest, copy bot token, generate an app-level token (`connections:write`, a manifest cannot create it), copy signing secret | Slack, triggers, gateways |
| Inbox protocol for out-of-band work | `runtime/src/gateway/inbox.ts`, `core/tools.ts` (`send_message`, `delegate`) | Borrow the pattern | Medium. File-drop polling does not fit Cloudflare. Replace with a queue or Durable Object, keep the five item kinds | Talking to agents, triggers |
| `delegate` and `send_message` tools (agent pushes a synthetic message into another chat) | `runtime/src/core/tools.ts` lines about 270-480 | Borrow the pattern | Low. A starting point for the agent inbox. It addresses chats, not agents, and has no threaded "forum" model | Talking to agents |
| Session storage and lookback | `runtime/src/state/db.ts` (tables `sessions`, `session_resume_ids`, `messages`, `messages_archive`, `messages_fts`), `state/sessions.ts` (`searchMessages`, `recentMessages`, `createChildSession`), `core/agent.ts` (`resolveParentInheritance`) | Copy schema, borrow queries | Low for the schema, and it maps to D1/SQLite. `memory_recall` with `cross_session: true` is the "look back at old sessions" feature. "Ask another agent for an extract" does not exist | Talking to agents, logging |
| Session resume via Claude session ids (`resume: latestSdkSessionId`) | `core/agent.ts`, `state/sessions.ts` (`appendSdkSessionId`) | Borrow the pattern | Note: the Claude Code transcript lives on the machine's disk under `~/.claude/projects`, so resume only works on the same machine and user | Creating and running agents |
| Profiles: many agents on one machine, each with its own home, DB, locks, inbox, pairing, systemd unit | `runtime/src/config/{paths,profiles,wrapper}.ts`, `cli/profile_bootstrap.ts`, `cli/gateway_service.ts` | Borrow the pattern, copy `paths.ts` | Medium. Isolation is by `BRUCE_HOME` directory, not by Unix user or container. Matches "dedicated directories", not "user accounts" | Creating and running agents |
| systemd and launchd install, linger preflight, `--replace` takeover, scope lock per bot token | `runtime/src/cli/gateway_service.ts`, `gateway/lock.ts` | Copy the code | Low. Good fit for a Harbourmaster "connector" process on an always-on box. Two processes on one Slack app split events, so the lock matters | Creating and running agents |
| Scheduler and tasks (tz-aware cron, `{{param}}` tasks, run ledger, 60 min abort) | `runtime/src/scheduler/{cron,scheduler,store,executor,target}.ts`, `tasks/`, `cron/ledger.ts` | Copy `cron.ts` and `executor.ts`, borrow the rest | Low to medium. Needs replacing JSON files with a DB and Cloudflare Cron Triggers for the cloud case. Pure cron math is portable | Slack, triggers (routines) |
| Chat-driven schedule creation (agent edits JSON via scripts) | `agent/.claude/skills/{manage-schedules,manage-tasks}/SKILL.md`, `agent/execution/{scheduler,tasks}/` | Borrow the pattern | Replace file writes with an API call or MCP tool. Whole-file rewrites caused a race (section 6) | Slack, triggers |
| `[ATTACHMENT:path]` outbound file convention with root and size policy | `runtime/src/gateway/{outbound_attachments,delivery}.ts` | Copy the code | Low. Simple and works with any runtime that returns text | Files |
| Inbound attachments (download with bot token, mime allowlist, size cap) and Deepgram transcription | `runtime/src/gateway/{attachments,transcriber/}` | Copy the code | Low | Files |
| Pairing gate for unknown users | `runtime/src/gateway/pairing.ts` | Copy the code | Low. Right size for "minimal permissions first" | Auth and permissions |
| Config loader: YAML plus Zod, `${VAR}` substitution, `.env` precedence, comment-preserving patches with the `yaml` Document API | `runtime/src/config/{schema,load}.ts`, `runtime/config.example.yaml` | Copy the approach | Low. Good model for a per-agent config file that the UI also writes | Creating and running agents |
| Append-only-ish logging: every message in SQLite, optional JSONL per session, `cron_runs` ledger, `agent:*` hook events with token counts | `state/jsonl.ts`, `cron/ledger.ts`, `gateway/hooks.ts`, `core/logging.ts` | Borrow the pattern | Not truly append-only (compression archives and replaces rows). Harbourmaster's log table should be separate | Logging and knowledge |
| Remote memory (Memory Stores), digester, dream consolidation behind a `DreamEngine` interface | `runtime/src/memory/**`, `runtime/docs/concept-remote-memory-and-dreaming.md` | Borrow the pattern | High effort. Interesting for the wiki idea, but it is a different design (cloud store plus mirror) from the brief's file-tree wiki. Skip for v1 | Logging and knowledge |
| Recalled-memory threat scan and skills injection scan | `runtime/src/memory/threat_scan.ts`, `runtime/src/skills/injection_scan.ts` | Copy the code | Low. Cheap defence for shared knowledge bases | Logging and knowledge, auth |
| The skill plus script workspace (3-layer model, `CLAUDE.md`, `.claude/skills`, `execution/*.ts`) | `agent/CLAUDE.md`, `agent/.claude/skills/`, `agent/execution/` | Borrow the pattern | This is how an agent gets capabilities today, instead of MCP. Some skills are reusable as is (gdrive upload and download, gws-*, youtube, transcription, meetings sync) | MCP connectors, files |
| tmux launcher for `claude-yolo` sessions with Remote Control | `bruce/agent/execution/tmux/launch_claude.ts`, `.claude/skills/launch-claude-session/SKILL.md` | Copy the code | Low. This is the "connect a Claude Code instance on a machine I control" path, done by hand today | Creating and running agents |

## 5. Brief coverage

**Creating and running agents.** Partly solved. An agent is a directory (`agent/` with `CLAUDE.md`, skills, `.env`) plus a profile home (`~/.bruce/profiles/<name>/` with `config.yaml`, DB, inbox). Running natively on an always-on Linux box is solved: `bruce gateway install`, user systemd unit, linger check, takeover, scope locks. Several agents per machine works through profiles and `~/.local/bin/<name>` wrapper scripts, each with its own gateway and systemd unit suffix. Not solved: any UI (creation is the `bruce init` CLI wizard and YAML), Cloudflare agents, Claude managed agents, Docker or Podman (the Dockerfile is stale), separate Unix users. Only one runtime exists: Claude Code through the Agent SDK. The runtime choice is hard-wired in `core/agent.ts`, so a runtime-adapter interface would be new work.

**Talking to agents.** Partly solved. Slack and Discord conversations work, one session per thread, resumed through the SDK session id and mirrored into SQLite. Slack streaming and agent view are good (`bruce`). A synthetic-message `delegate` tool and `bruce send` let agents and scripts push messages into chats. Session lookback is solved for the agent itself (`memory_recall` over FTS5, cross-session, parent-session inheritance of the last 10 messages). Not solved: MCP server that lets Claude talk to Bruce ("Hey Claude, message Bruce"), agent-to-agent extracts, an inbox or forum separate from Slack. The nearest piece is the inbox directory protocol, which is a local file queue.

**MCP connectors and credentials.** Barely solved. `bruce-next` loads a workspace `.mcp.json` of stdio servers and the `bruce mcp list|add|remove` CLI edits it. No HTTP or SSE servers, no OAuth, no central registry, no assignment of connectors to several agents, no vault. Credentials are one flat `agent/.env` per agent plus Google OAuth files under `agent/execution/credentials/` and the `gog` CLI with two hard-coded Google accounts in `agent/CLAUDE.md`. All three brief credential cases (user-bound, colleague, agent) collapse into "the agent's own env". In practice Bruce reaches services through skill scripts, not MCP.

**Slack, triggers and gateways.** Mostly solved for the single-operator case. Slack via Socket Mode with a manifest generator and name-based setup, mention gating (`require_mention`, `free_response_channels`) which covers "tagged in a thread" and "monitor a whole channel", slash commands, multi-workspace, per-channel prompts. Triggers: Slack messages, YAML cron, chat-created schedules and tasks (cron with timezone), CLI `bruce send` and `bruce cron run` through the inbox. Not solved: an authenticated HTTP endpoint trigger (GAPS lists "webhook jobs" as deferred; `bruce` has a WhatsApp webhook server but no generic bearer endpoint), one-click Slack OAuth install (still 3 manual copy steps), Slack over HTTP for a Cloudflare deployment, other gateways beyond Discord (WhatsApp and Mattermost only in old `bruce`).

**Files.** Partly solved. Slack and Discord file upload in (`attachments.*`, bot-token auth, mime allowlist, 25 MB cap) and out (`[ATTACHMENT:path]`, 50 MB cap, allowed roots). Voice notes transcribed via Deepgram. Skills exist for Google Drive upload and download, and a meeting sync from Meet, Granola and Plaud into The Brain. Not solved: Drive or OneDrive connectors as platform features, Samba gateway, file-landed triggers, scanning other people's Meet folders. Attachments are never garbage collected (GAPS 2.17).

**Logging and knowledge.** Partly solved. Every user and assistant message, token count, reasoning trace and cron run is stored in SQLite (and optional JSONL), plus `agent:start/end/error` hooks. It is a transcript store, not an action log: tool calls are not recorded as rows (only `tool_use` events pass through memory in the run), and compression deletes rows from `messages` into `messages_archive`. Knowledge: `memory_save`/`memory_recall`, optional cloud Memory Stores with a dream pipeline, and the workspace's own files. No shared wiki, no file-command knowledge base, no cross-agent sharing.

**Auth and permissions.** Minimal, by design. Pairing codes plus `owner_user_ids` per platform. Owners are global per platform, not per workspace (GAPS 2.23). The agent runs with `permissionMode: "bypassPermissions"` and `Bash`, `Edit`, `Write` allowed in `working_directory`, so a paired user has full shell on the box (GAPS section 4 says so). The old `bruce` has regex block lists for paths and commands. No Clerk, no web users, no roles. Fine for one operator, and the pairing store is the right shape to key on a Clerk user id later.

## 6. Gotchas and lessons

- **Two gateways on one Slack app split events at random.** Each message reaches one process. `bruce`'s setup-slack-bot skill records that `bruce` and Bruce Reborn run on two different Slack apps ("Bruce Ops" and "brucebot"). Harbourmaster needs one process per Slack app and a lock. `runtime/src/gateway/lock.ts` does that per token hash.
- **App-level Slack token cannot come from a manifest.** `connections:write` token is a manual click. The brief's "few clicks" install needs the Slack OAuth flow (HTTP receiver), not Socket Mode.
- **Slack agent view is fragile.** `agents.sessions.setStatus` accepts only `active|processing|suspended|closed`, free text fails with `invalid_arguments`. Some features need a paid plan, and `chat.startStream` failure falls back to plain messages. Slack changes these APIs often (note in the skill).
- **Whole-file JSON stores race.** The scheduler gateway and the scripts each rewrite `schedules.json`. A script write inside the gateway's 500 ms pending-save window is lost (GAPS 2.33). A DB or an API fixes it.
- **Inbox handlers must return before the run ends.** The watcher re-dispatches an item every second until its handler resolves, so awaiting a multi-minute agent run starts it again each tick (Cycle 8 lessons).
- **A CLI process has no agent.** Anything that needs agent execution must go through the gateway's inbox. Writing a raw outbound message delivered the prompt text itself (Cycle 1 bug).
- **Moving files broke an artifact no test covered.** The Dockerfile references `runtime/bun.lock`, `runtime/skills/` and does not ship `agent/`. Grep deploy files when restructuring (Cycle 8).
- **Silent config meaning change.** Anchoring `working_directory` at the config file means an old `working_directory: "."` now points at the config dir.
- **Headless Linux needs `loginctl enable-linger`.** User systemd fails without a D-Bus socket on SSH-only boxes. Test installs from a fresh SSH session (Cycle 3).
- **Bun does not keep daemons alive on its own.** Long-lived WebSockets and timers do not hold the loop open. `gateway.ts` awaits an explicit shutdown promise (post-Cycle 2).
- **Keep platform tokens out of the agent.** `buildAgentEnv` drops `SLACK_*` and `DISCORD_*`, and `CLAUDECODE` so the SDK does not think it is nested. Other secrets in `agent/.env` still reach every Bash call.
- **Setting sources matter.** `settingSources: ["project"]` stops the bot inheriting the operator's `~/.claude`. The runtime's own skill index must stay off or skills are listed twice.
- **Session resume is machine-local.** Resume ids point at Claude Code transcripts under `~/.claude/projects`. Moving an agent to a new machine loses resume, though Bruce's own `messages` table survives. Parent inheritance covers the gap.
- **Discord, Slack session edge cases.** Multi-workspace session keys were not migrated (GAPS 2.20), and synthetic inbox messages carry no `team_id` so they land in a different session than a real message (GAPS 2.24).
- **Memory API limits.** `view=full` caps `limit` at 20 upstream, and the hosted Dreams API required a research-preview grant. Remote memory data leaves the machine and is not ZDR-eligible.
- **Docs and code disagree in small places.** `slack.ts` header says "bolt v4" while `package.json` has `^5.1.0`. `bruce/agent/README.md` documents a Mattermost-only gateway and a `mattermost-bot.service` file, but the code has four channels and `setup-service.sh` generates the unit. `bruce`'s root has no README or CLAUDE.md, only `agent/`. `runtime/CLAUDE.md` is titled "bruce-reborn" and says "~670 tests", which matches (670). `bruce/agent/CLAUDE.md` hard-codes Dom's Google accounts, so it is not portable as is.
- **Docs I did not trust blindly.** Test counts and "shipped" lists in `README.md` and `PROGRESS.md` matched the code where I checked (tool list, schema v7, scheduler files, Slack adapter). I did not run the gateway or any live platform. GAPS section 3 itself says no test exercises a real Slack reconnect.

## 7. Maturity

| | bruce-next | bruce |
|---|---|---|
| Last commit | 2026-09-22 (`1629712`, docs), 50 commits in this repo, history from 2026-06-11 (runtime history from April via subtree) | 2026-09-22 (`487b0d8`, Slack agent view), 50 commits, from 2026-03-24 |
| Working tree | Clean | Dirty: modified skills, `collect_plaud.ts`, `bun.lock`, two skills staged for deletion |
| Tests | 87 files, 670 tests (669 pass, 1 skip) under `bun:test`, all with mocked platform clients. `agent/execution` has its own tests | Few: `agent_stream.test.ts`, `scheduler/cron.test.ts`, `scheduler/store.test.ts`, some meeting script tests |
| Typecheck | Strict `tsc` is part of the done check | Not enforced at the root |
| Deployed | Docs say Bruce Reborn runs as the `bruce` binary with `~/.bruce/.env` on Dom's machine. I did not check the process list | Docs say a system service `bruce-bot` runs with its own Slack app. Same caveat |
| Completeness | Gateway, Slack, Discord, sessions, scheduling, files, profiles, systemd: working and heavily tested. Known open items: Docker image, Slack agent view not ported, two scripts (`run_task.ts`, `check_scheduler_health.ts`) still target the retired service, todos are posted to the channel and not DM'd | Working Slack agent view, meetings pipeline, newer skills. Gateway features (pairing, profiles, SQLite, CLI) absent |
| Fit for Harbourmaster | Best source for the runner, adapter contract, Slack adapter, scheduler maths, pairing, service install. Needs a hosted DB, an HTTP Slack receiver and MCP and credential layers around it | Source for Slack agent view, manifest setup, tmux/Remote Control launcher |

Suggested merge order if Harbourmaster reuses this: take `base.ts`, `slack.ts`, `delivery.ts`, `agent.ts`, `cron.ts`, `pairing.ts`, `gateway_service.ts` from `bruce-next`; add `agent_stream.ts` and the manifest generator from `bruce`; leave out the memory and dream code until a wiki design exists.
