# Hermes Agent (Nous Research): product and UX notes

Research date: 19 Nov 2026. Sources are listed at the end. "Unverified" marks claims from secondary sources or claims I could not confirm.

## Overview

Hermes Agent is an MIT-licensed, self-hosted agent with a built-in learning loop. The GitHub repo shows about 264k stars. The latest stable release is v0.23.2 (16 Nov 2026). The last feature release is v0.23.0 "The Hearth Release" (5 Nov 2026). Releases ship roughly weekly, with daily canary builds.

The product has moved from "CLI plus chat bots" to four surfaces on one runtime: CLI/TUI, Hermes Desktop (Electron), the Webapp (Desktop's workspace served in a browser), and messaging bots. Since v0.23.0 each machine runs one gateway that owns all sessions. Every surface, including ACP editors and cron, attaches to it as a client and shares queue and history.

I found no feature named "personal agent setup". The closest matches are the three-mode setup wizard, the "New Agent" flow in Bot Mode, and Hermes Cloud's one-agent deploy. Treat the name as unverified.

## Setup and onboarding

- Install: Desktop installer on macOS and Windows (installs CLI too), or `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`. PowerShell, Termux, Nix and Docker variants exist.
- `hermes setup` offers three modes. Quick Setup uses Nous Portal OAuth with no API keys, and one subscription covers 300+ models plus the Tool Gateway. Full Setup is bring-your-own-keys. Blank Slate enables only model, file and terminal tools.
- The wizard detects OpenClaw, Claude Code, Codex and Cursor and offers an import with a preview.
- The docs state a rule: get one normal chat working before adding features. Messaging comes later through `hermes gateway setup`.
- Desktop first run shows an overlay that leads to a first message. "Choose provider later" skips provider setup. The user picks a Basic or Elite interface mode.
- Hermes Cloud (portal.nousresearch.com/cloud): sign in, add $2 credit or hold a subscription, pick name, model and size, deploy in about 60 seconds. Each agent gets a dedicated container, persistent workspace and its own dashboard. Compute bills per second and scales to zero. Plans: Plus $20, Super $100, Ultra $200 per month (prices from AlphaSignal, unverified against the portal). 14 regions.
- Webapp (v0.23.0): off by default, enabled with `webapp.enabled` or Settings, Web Access. Public exposure requires sign-in.

## How a user talks to it

- CLI and TUI, with rewind (Esc twice or `/rewind`) to edit a past message or fork a session.
- Desktop and Webapp.
- Messaging: Telegram, Discord, Slack, WhatsApp, Signal, Email, SMS, Teams, Google Chat, Matrix, Mattermost, iMessage bridges, Feishu, WeCom, LINE and more (20+).
- Voice: memo transcription, TTS replies, Discord voice channels, a "Hey Hermes" wake word, and a full voice conversation button in Desktop.
- API: OpenAI-compatible server, and ACP for VS Code, Zed and JetBrains.

Sessions: each chat on a platform is one continuous session until the user sends `/new` or `/reset`. Timed resets moved to a plugin. Chat commands include `/model`, `/resume`, `/sessions`, `/title`, `/compress`, `/usage`, `/bg` (a separate background agent that posts its result back), `/approve` and `/deny`. A home channel set with `/sethome` receives restart notices and alerts. Desktop groups sessions by project (repository), shows three recent sessions per project, and shows git worktrees as lanes.

## Agent identity and config

- `SOUL.md` in the Hermes home sits first in the system prompt. `/personality` applies preset overlays (concise, technical, teacher, pirate and others). Custom ones live in `config.yaml`.
- A profile is a separate home under `~/.hermes/profiles/<name>/` with its own config, `.env`, SOUL, memory, sessions, skills and cron. Each profile gets a command alias and its own gateway and bot token. Profiles isolate state, not the file system.
- Bot Mode presents each profile as a "Bot" with an avatar, a permanent Bot Chat and routines. "New Agent" asks for name, title and description. An Advanced section sets clone source, model pin, SOUL, skills, toolsets, MCP servers and whether keys copy over.
- Model choice: `hermes model`, a picker in the composer, per-cron-job and per-Kanban-task pins, separate models for subagents and auxiliary jobs. Minimum context is 64k tokens.

## Memory and self-improvement

- `MEMORY.md` (2,200 characters) and `USER.md` (1,375 characters) are injected as a frozen snapshot at session start. The tool has add, patch and remove. Memory does not auto-compact, so the agent must free space when full.
- After a turn, a background review may save memory or create or patch a skill. Triggers for a skill: a multi-step workflow worth repeating, a recovered dead end, or a user correction.
- Optional gates: `memory.write_approval` and `skills.write_approval` stage writes for review with diff, approve and reject commands. `hermes curator lock` makes a skill read-only to the agent. `/journey` shows a timeline of what it learned.
- Skills follow the agentskills.io format with three disclosure levels. The Skills Hub pulls from several registries, assigns trust levels and scans installs. Built-in skills dropped from 58 to 44 in v0.23.0.
- Session search uses SQLite FTS5 over all sessions.
- Honcho and other memory backends (Mem0, Supermemory, Hindsight) install as plugins. Honcho moved out of the core path, so the README's "Honcho user modeling" line now means an optional provider.

## Subagents, delegation, A2A, teams

- `delegate_task` spawns isolated children. Defaults: 10 concurrent per batch, depth 1, 250 turns each. Only the summary returns. Completions persist across gateway restarts. Desktop shows a Subagents frame above the composer with steer and stop.
- The `advanced-delegation` plugin routes children to named profiles or to a model map.
- Kanban: a SQLite board shared by all profiles. Columns are triage, todo, ready, running, blocked, review, done, archived. A dispatcher in the gateway polls about every 60 seconds and runs the assigned profile as a worker. Humans comment and unblock. A chat that creates a task gets completion and block notices.
- Group Chats: rooms of 2 to 6 Bots with @mentions, threads, a lead bot or an automatic router, room purpose and notes, a "needs you" badge, and loop caps (10 messages, 3 rounds). Rooms can span machines.
- A2A v1.0 plugin, bundled since v0.20.0 (Aug 2026, date from a secondary source). Inbound: Agent Card at `/.well-known/agent-card.json` and JSON-RPC on port 9900, with SSE streaming and signed push notifications. Outbound tools: `a2a_discover`, `a2a_call`, `a2a_list`, `a2a_history`, `a2a_orchestrate`. Inbound tasks land in a live gateway session keyed by `contextId`. Bearer tokens per peer, 60 requests per minute, 5-turn ping-pong cap, JSONL audit log. Off by default.
- Bot-to-bot inside Hermes uses `message_agent` and `hermes peer`, not A2A.

## Scheduling, triggers, notifications

- Cron jobs come from natural language, `/cron add`, the CLI or the dashboard. Formats: delays, intervals, day phrases, cron expressions, ISO timestamps.
- Delivery targets: origin chat, local file, a platform home channel, a specific chat, all, a Bot Chat or a Group Chat.
- Per-job skills, model, reasoning effort, timezone, workdir, toolsets, catch-up policy and output chaining. `--no-agent` runs a script with no LLM call. A script can return `{"wakeAgent": false}` to skip a tick. `[SILENT]` suppresses delivery.
- Webhook subscriptions can fire a cron job or start a run. Event hooks run code at lifecycle points.
- Cron runs cannot create cron jobs by default.

## Execution environments

- Terminal backends: local, Docker, SSH, Modal, Daytona, Vercel Sandbox. Plugins add Singularity and Fly Sprites.
- Docker keeps one persistent container per profile by default. Modal and Vercel snapshot the file system. Daytona stops and resumes sandboxes.
- Browser: one tool, `browser_exec`, runs model-written Python against local Chromium, a cloud browser, or the user's Chrome over CDP. The ten older `browser_*` tools were removed in v0.23.0.
- `computer_use` and a "Bot Screen" exist. The Bot Screen is a per-bot desktop with a persistent browser that the user can take over for logins. I did not read those pages in full.
- Checkpoints snapshot the working directory before file edits. `/rollback` restores.

## Tools, MCP, credentials, approvals

- Toolsets are enabled per platform. MCP runs over stdio or HTTP with per-server tool filtering and a Nous-approved catalog. The plugin catalog has over 1,050 entries with a Verified tier.
- Paid MCP tools declare a per-call price. Approval prompts show the price and chat total. Spend limits hold even in YOLO mode.
- Secrets live in `.env` or a secrets backend. Child processes get secret-named variables stripped. MCP servers receive only declared variables. `browser_vault` fills logins from 1Password or Bitwarden without exposing them to the model.
- Approvals: `smart` (an auxiliary model rates risk, default), `manual`, `off`. Choices are once, session, always, deny. A hardline blocklist has no override. Messaging users answer yes or no, and `approvals.approvers` limits who may answer. Headless contexts deny by default.
- Messaging access is deny by default, with allowlists and DM pairing codes.

## What users praise and complain about

Reddit mirrors returned 403 and I found no Hacker News thread, so this section rests on secondary summaries. Treat it as unverified.

Praise: lean setup, memory that works out of the box, checkpoints as a safety net.

Complaints:
- Token use. A Reddit post titled "Sad reality of Hermes: Token Furnace" reports a 40-token prompt becoming a 20,538-token request.
- The learning loop rates its own work too kindly ("it always thinks it did a good job").
- Fear that self-edits tangle a working setup.
- Chat apps suit short commands, not long work sessions.
- Desktop and remote-gateway reliability: stuck "Connecting", session lease errors, Windows service problems, a generic "Something went wrong" reply (GitHub issue numbers in the BetterClaw list, unverified).
- Two different apps are called "Hermes Desktop".

## Dashboard and UI layout, in words

Web dashboard (`hermes dashboard`, port 9119): a left sidebar with a profile switcher and a sign-in widget. Pages: Status, Chat (the TUI in xterm.js with a right rail for model, session list and workspace), Sessions, Logs, Analytics, Cron, Profiles, Skills, MCP, Webhooks, Pairing, Channels, Kanban, System, Config (form editor for `config.yaml`), API Keys. An amber banner names a non-default profile.

Desktop and Webapp: a left sidebar with a "Sessions | Bots" tab strip and a rail of coloured profile squares at the bottom. The centre holds chat with a composer (model picker, reasoning pill, mic). The right side holds file browser, terminal tabs, Git review and a preview rail. A bottom status bar shows the YOLO toggle, context meter, workspace, model and gateway state. Other pages: Artifacts gallery, Memory Graph, Scheduled jobs, Skills, Messaging, Agents, Command Center, Capabilities, Profiles. Cmd/Ctrl+K opens a command palette. Layout presets are Basic, Focus, Default, Terminal deck and Quad.

## UI and UX patterns worth copying

- One session owner per machine, so every surface sees the same queue and history.
- An agent roster where each agent has one permanent chat plus routines, and group rooms sit in the same list with a "needs you" badge.
- Simple and Advanced interface modes that hide controls without removing capability.
- An "Applies to" chip row on settings pages that names which agent an edit targets.
- Staged memory and skill writes with a diff and approve step, and a learning timeline.
- Price shown inside the approval prompt, with a per-chat spend limit.
- A subagent strip above the composer with steer and stop.
- Cron delivery as a first-class target picker, including "post into this room".
- Kanban for durable, human-interruptible work, and delegation for quick fan-out.
- A router that shows "Assigned to X" when it picks a responder.

## Weak spots

- Concept sprawl: profile, bot, agent, gateway, connection, workspace, project, toolset, skill and plugin overlap. Two dashboards (the 9119 dashboard and the Webapp) coexist.
- Built for technical single users. Config lives in YAML and `.env`. There are no org roles beyond per-platform admin tiers.
- Profiles are not a security boundary.
- Memory caps are tiny and manual. The frozen snapshot delays updates to the next session.
- High baseline token cost per turn.
- Release pace (about 2,000 PRs per patch) brings regressions, mostly in Desktop, Windows and remote connections.
- A2A is an optional plugin on a separate port. Internal bot messaging uses a different mechanism.

## Sources

All accessed 19 Nov 2026.

- https://github.com/NousResearch/hermes-agent
- https://github.com/NousResearch/hermes-agent/releases
- https://hermes-agent.nousresearch.com/docs/
- https://hermes-agent.nousresearch.com/docs/getting-started/quickstart
- https://hermes-agent.nousresearch.com/docs/user-guide/features/overview
- https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard
- https://hermes-agent.nousresearch.com/docs/user-guide/desktop
- https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode
- https://hermes-agent.nousresearch.com/docs/user-guide/profiles
- https://hermes-agent.nousresearch.com/docs/user-guide/features/personality
- https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
- https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
- https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation
- https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban
- https://hermes-agent.nousresearch.com/docs/user-guide/features/cron
- https://hermes-agent.nousresearch.com/docs/user-guide/features/browser
- https://hermes-agent.nousresearch.com/docs/user-guide/messaging/
- https://hermes-agent.nousresearch.com/docs/user-guide/messaging/a2a
- https://hermes-agent.nousresearch.com/docs/user-guide/security
- https://hermes-agent.nousresearch.com/docs/user-guide/configuration
- https://portal.nousresearch.com/cloud
- https://alphasignal.ai/news/nous-research-brings-hermes-cloud-s-desktop-agent-into-any-browser (secondary)
- https://runtimewire.com/article/nous-research-hermes-agent-v0200-voice-a2a (secondary, search snippet only)
- https://www.betterclaw.io/blog/hermes-agent-bugs-fixes (secondary, competitor blog)
- https://pasqualepillitteri.it/en/news/3864/hermes-agent-review-community-opinions (secondary)
- https://deuts.org/x/866-why-does-hermes-use-so-many-more-tokens-than-claude-code-r-hermesagent/ (secondary, search snippet only)

Not reachable: r.datuan.dev Reddit mirror (HTTP 403). The release tag URL I guessed for v0.23.0 returned 404, so release details come from the releases index page. Several doc pages exceeded the fetch limit and were read only in part (desktop, kanban, cron, configuration, web-dashboard).
