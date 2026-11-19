# OpenClaw: product and UI notes

Researched 19 Nov 2026 from docs.openclaw.ai, the GitHub README and press. It builds on the code analysis in `docs/analysis/openclaw.md` (16 Oct 2026, version 2026.2.25) and covers what is new or UI related. I did not run the product. Docs were read through a summarising fetcher, so labels may differ slightly. "Unverified" means no primary source.

## Overview

OpenClaw is an MIT-licensed personal agent that runs as one Gateway process on the user's own machine or server. The Gateway owns the chat channels, the agents, their sessions and a web app, the Control UI. The README says the project "has no paid tier, hosted service, or token" and GitHub shows about 395k stars. Peter Steinberger joined OpenAI in Feb 2026, and press reports an OpenClaw Foundation since July 2026 (unverified).

The big change since the February snapshot is the Control UI. It grew from a config dashboard into a multi-user workspace with an agent selector, session sidebar, presence, inbox, side panels, dashboards and a kanban board. Several gaps the old analysis listed are closed: agent creation in the UI, an MCP page with OAuth, user roles, and a team preset.

## Onboarding and setup

Install with a curl or PowerShell script, then run `openclaw onboard`. The wizard shows a security notice, asks for the first agent's name, and offers "Full access" (scan for existing AI apps and keys) or "Ask first". It lists detected model access such as Claude Code or Codex logins, and the chosen one must pass a real completion test before it is saved. It offers to import memories from Claude Code, Codex or Hermes, suggests plugins, then opens the Control UI. Docs claim "about 5 minutes" to first chat. Channels and further agents are set up later by asking in chat. Native apps exist for macOS, Windows, Linux, iOS and Android. Setup is still terminal first, and reviews name it as the main reason non-technical users give up.

## Main UI layout

- Sidebar top: agent selector with "Create new agent" (name, avatar), a show-all team view and a settings gear per agent.
- Pages: Automations, Dashboards, Sessions, Usage, Board, Activity, Meetings, MCP, Templates.
- Sessions: pinned sessions, sections and shared groups, with filters Active, Snoozed, All and My sessions, Involving me, All sessions.
- Sidebar bottom: Online (people with presence and running-session counts), Inbox, connection indicator.
- Chat: transcript with a "Worked for ..." summary per run and expandable tool calls. Agent questions appear as a card above the composer with choices, Submit and Skip. Failed replies offer Try again and Edit message. "Send now" interrupts tools to steer. The composer has a model picker, attachments and a context ring.
- Details panel: environment (workspace, branch, device, model), changes, background tasks, automations, participants, task progress.
- Side panels: Subagents, Processes, Files (workspace tree, session files, preview), Changes (diffs), Desktop viewer, Terminal, Browser, Dashboard.
- Command palette (Cmd/Ctrl+K): search sessions, or compose a background session.
- Settings: Devices and pairing, Gateway, Models, Memory, Skills, Labs, plugins, MCP.
- Mobile: a PWA with web push, paired by setup code.

Canvas and nodes: the A2UI canvas is retired. Agents build HTML or report widgets that render inline in chat, pin to a per-session dashboard (grid, tabs, focus mode), or show in a floating panel on a paired Mac. A widget that wants network, Gateway data, automation triggers or prompt access must declare it, and approval is bound to the exact code. Nodes are paired devices (macOS, iOS, watchOS, Android, headless hosts) that expose camera, screen, location, notifications, voice and `system.run`. An operator approves each node once under Devices.

## Talking to agents and organising work

Users talk through the Control UI, the apps, or channels: WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Teams, Google Chat and 20 more. Work is organised by session. A session belongs to one agent and has a creator, an assignable owner and participants. The Board page (Workboard plugin, off by default) adds kanban. Cards boards hold work items with status, priority, assigned agent and proof. Sessions boards sort existing sessions into Needs input, Stuck, Working, In review and Done from run facts. A dispatch pass claims ready cards and starts worker subagents.

## Agent identity and config

An agent is a workspace folder plus state. `AGENTS.md` holds the job and standing orders, `SOUL.md` the persona and hard limits, with `IDENTITY.md` and `USER.md` beside them. Users create agents from the selector or through a "custodian" chat that waits for approval. The Agents page shows roster, work status and recent chat previews. Templates (experimental) package an agent's instructions, skills, plugins, MCP servers and automations without memories or secrets, and only the human can publish one. Bindings route channel accounts to agents. The delegate pattern gives an organisational agent its own mailbox so it never poses as a person, with three tiers: read and draft, send on behalf, proactive.

## Memory, knowledge, skills, self-improvement

Memory is Markdown in the workspace: `MEMORY.md` for curated facts, daily notes under `memory/`, `USER.md` for preferences, with hybrid vector and keyword search. Dreaming is on by default. A nightly sweep in three phases promotes repeated signals into `MEMORY.md`, keeps a rollback copy and writes a readable Dream Diary shown in a Dreams tab. An optional memory wiki tracks claims, evidence and contradictions. Skills are `SKILL.md` folders, per agent or shared. ClawHub hosts skills and plugins with versions, scan results and reports.

## Teams and multi-agent

Subagents run in their own sessions and announce results to the parent. The Subagents panel lists them as Running and Finished with view-only transcripts and a Stop button. `openclaw agents team create` scaffolds a coordinator, researcher, writer and reviewer, each with a lane contract in `AGENTS.md` (owns, does not own, chat budget, handoff, tool posture). Specialists report to the coordinator and do not delegate further.

Multi-user mode adds profiles with GitHub sign-in through Cloudflare Access or Tailscale, operator scopes (read, write, admin), session visibility (Shared, Read-only, Suggest, Draft, public link), invites by @mention, typing indicators, reactions and an Inbox of mentions. The docs say plainly that these are usability features, not a security boundary.

## Scheduling, triggers, background work, notifications

Cron is now called Automations and has a UI page. Jobs are one-shot, recurring or condition-triggered, plus webhooks and Gmail Pub/Sub. A job runs in the main session, the current one or an isolated one. Output goes to a chat channel, a webhook or nowhere, and failures notify. Heartbeat is being migrated into ordinary editable jobs. Because the Gateway is always on, the agent can message first in any channel.

## Execution environment

Tools run on the Gateway host or in per-agent sandbox containers, and a managed browser has its own panel. New since February: cloud workers. The Crabbox plugin leases disposable machines on AWS, Azure or Hetzner and attaches one to a conversation. A Desktop viewer panel streams it. A person can take control, which pauses agent input, then hand back. One controller at a time, others watch. Workers are temporary, so files must be copied out. Persistent files live in the agent workspace. There is no app hosting.

## Connectors, MCP, credentials, approvals, safety

The MCP settings page has server rows, toggles, a config editor and OAuth sign-in per account. Servers can be scoped to "This session" or "Everywhere". Keys are entered as values or secret references. Exec approvals have five modes: deny, allowlist, ask, auto (a reviewer model allows, denies or escalates) and full. Approval cards show in the Control UI and mac app, and as reactions or `/approve` in chat. With no approver reachable the default is deny. Researchers found 341 malicious ClawHub skills in Feb 2026, and later audits counted over 1,000 (press figures). ClawHub now scans uploads and shows scan state before install.

## Pricing and usage display

Free software. The user pays model providers or reuses a Claude or Codex login. The Usage page totals tokens and estimated cost by provider, model, agent and channel from local transcripts. `/usage full` adds a cost footer to each reply. Community reports mention surprise bills of hundreds of dollars a month (anecdotal).

## What users praise and complain about

Praise: it lives in the chat apps people already use, messages first, has real access to their machine, keeps plain files they can edit, and works with any model. Complaints: setup needs ops skills, gateway and auth break after updates, token cost is unpredictable, and security exposure.

## UI and UX patterns worth copying

- Agent selector at the top of the sidebar, plus a roster page with status and chat previews.
- "Involving me" filter and a Sessions board that sorts sessions into Needs input, Stuck, Working and Done with no manual upkeep.
- Details panel for environment, changes, background tasks, automations and participants.
- Subagents panel with nested child runs and a view-only transcript beside the parent.
- Agent questions as a card above the composer with choices and Skip.
- Per-session dashboards of agent-built widgets with declared permissions.
- Desktop viewer with explicit take control and hand back.
- Lane contract template and scaffolded coordinator team.
- Dream Diary: a readable log of memory changes, with rollback.
- Onboarding that detects model access and tests it before saving.
- Creator, owner and participants as separate session fields.

## Weak spots

- One trusted group per Gateway. Roles and drafts do not protect data.
- Terminal-first, self-hosted setup with no managed option.
- A dense, developer-shaped UI (worktrees, diffs, terminals) with a growing page list.
- No cost cap, and usage is an after-the-fact estimate.
- Open skill registry with a malware record.
- Disposable cloud workers that do not sync the workspace.
- Names and homes of features keep changing (cron to Automations, canvas to widgets, heartbeat to jobs).

## Sources

All accessed 19 Nov 2026.

- https://docs.openclaw.ai/llms.txt (index), and under https://docs.openclaw.ai/: web/control-ui.md, web/dashboards, start/getting-started, cli/onboard, nodes, platforms/mac/canvas, concepts/multi-agent, concepts/agents-and-templates, concepts/multi-user, concepts/delegate-architecture, concepts/parallel-specialist-lanes, concepts/memory, concepts/dreaming, tools/subagents, tools/exec-approvals, plugins/workboard, automation/cron-jobs, gateway/cloud-workers/desktop, cli/mcp/control-ui, clawhub, reference/api-usage-costs
- https://github.com/openclaw/openclaw (README)
- https://thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html (search snippet only)
- https://thenewstack.io/openclaw-foundation-nonprofit-status/ (search snippet only)
- https://www.eesel.ai/blog/openclaw-ai-review (search snippet only, user complaints)
- Local: /home/roboto/devel/harbourmaster/docs/analysis/openclaw.md
