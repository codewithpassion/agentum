# Agentum feature and UI inventory

Written 19 Nov 2026 from the docs and the code on `main`. It is input for the UI reimagining: every capability that exists today, how the UI exposes it, and where the UI gets in the way.

## How to read the state column

| State | Meaning |
|---|---|
| Production | `docs/HANDOVER.md` records it running on production (latest recorded version 67613c23, 3 Nov 2026). |
| Done in code | The task files say `done` and the code is on `main`, but the work landed after 3 Nov or the docs record no production deploy. I did not check the live Worker. |
| Built, not accepted | Code is on `main`, the task files still say `review`, `in_progress` or `todo`. |
| Planned | A doc describes it, no code. |
| Absent | Not in docs or code. |

Where docs and code differ I followed the code. The differences:

- `docs/ux-review/rail/spec.md` gives the rail foot as Agents, Files, Everything. The code (`rail-footer.tsx`, after `rail/footer.md`) has four tabs: Agents, Apps, Files, and Settings for admins. Find moved to the top bar.
- `docs/ux-review/task-view/spec.md` describes `/tasks/$runId` as the page. Since the TH tasks (10 Nov) that route only redirects to `/threads/$sessionId`.
- `docs/analysis/navigation-and-settings.md` and `docs/ux-review/review.md` describe a page sidebar and agent tabs. Both are gone: the rail replaced the sidebar, and the agent page is one page with sheets.
- `docs/v3/workspace-assistant.md` and the Find entry say Assistant is a page. `/assistant` redirects to `/desk?assistant=...`, and the assistant is a panel over any page.
- HANDOVER says the only open tasks are the live artifact ones. The task files also show RC.7 (machine client staging test) blocked, CL.7 in progress and LR.17 todo.
- `apps/daemon` and `apps/computer` hold only build leftovers. `apps/agentum` (Rust) is the one machine client.
- `docs/v3/mcp-agent-management.md` says only a session user manages agents over MCP. `admin-access.ts` also admits a write OAuth client (noted in `docs/analysis/small-agent-teams.md`).

## 1. Capabilities

Key paths are relative to the repo root. `web` means `apps/web/src`, `svc` means `packages/services/src`.

### Agents

| Capability | What it does | State | Where in the UI | Key code |
|---|---|---|---|---|
| Agent list | Table of agents: who each asks, waiting or working, tasks and cost this week | Production | `/agents`, rail footer tab Agents | `web/routes/_app/agents.index.tsx`, `components/agent/agents-table.tsx` |
| One-page profile | Rows Does, Owner, Tools, Starts on, Works with, then More: Voice, Skills, Library, Channels. Side cards: Runs on, Ask me before it, Conversations, Recent tasks, Computer | Production | `/agents/$agentId`, from the list, Find or an agent name anywhere | `components/agent/profile/*`, `svc/agent-profile` |
| Manage sheets | Six sheets edit the rows: tools, skills, handsTo, startsOn, channels, edit | Production | `?sheet=` on the profile, opened by Manage on a row | `profile/sheet-ids.ts`, `profile/sheets/*` |
| Create by describing | Describe the job, review a draft, dry run with sample input, create. Also Start blank | Production | `/agents/new`, New menu in the top bar, Agents page, Board | `routes/_app/agents.new.tsx`, `components/agent/builder/*`, `svc/agent-builder` |
| Owner and backup | The person an agent asks, and a second person after 4 hours | Production | Owner row on the profile | `profile/asks-row.tsx`, `agents.owner_user_id`, `backup_user_id` |
| Ask-before settings | Ask level (rarely, outside, everything, custom) plus per-tool overrides and allowed mail addresses | Done in code (levels AB.1, 10 Nov; rules Production) | Ask me before it card on the profile | `profile/ask-before-card.tsx`, `agent_tool_rules`, `svc/requests` |
| Voice | Tone preset plus free text ("soul") | Production | Voice row under More | `profile/voice-field.tsx`, `agents.soul` |
| Archive and restore | Archive stops an agent, restore brings it back | Done in code (MA.2) | Archive in the Edit sheet; Archived (N) toggle on `/agents`; banner on an archived profile | `agent/archived-agents.tsx`, `svc/agents.ts` |
| Move agent | Change runtime or machine | Done in code (RT.2) | Runs on card | `profile/move-agent-dialog.tsx` |

### Runtimes

| Capability | What it does | State | Where in the UI | Key code |
|---|---|---|---|---|
| Machine | The Rust `agentum` client runs Claude Code on an enrolled machine | Production (Rust client RC done in code, staging test RC.7 blocked) | Runs on card; Settings, Machines | `apps/agentum`, `web/server/routes/machines.ts`, `MachineRelay` DO |
| Cloud isolate | Pi Durable in the `PiRun` Durable Object | Production | Runtime and Environment fields in the Edit sheet | `svc/cloud`, `web/server/pi-run-core.ts` |
| Cloud Linux VM | Same agent loop with a VM through `VmSession` | Production | Environment field in the Edit sheet | `VmSession` DO, tasks C.14, W.2 |
| Anthropic Managed Agents | Runs on Anthropic's service, polled by `ManagedPoller` | Production | Runtime field, shown as Anthropic cloud | `svc/managed` |
| Model providers | Workspace Anthropic key and OpenRouter key | Production | `/settings/model-providers` | `svc/model-keys.ts`, `managed` keys |

### Tasks, runs, threads and chat

| Capability | What it does | State | Where in the UI | Key code |
|---|---|---|---|---|
| Start a task | Pick an agent, write what it should do, attach files | Production | New, New task (top bar); Board; profile header | `components/desk/new-task-dialog.tsx`, `svc/runs` |
| Thread page | One session with all its runs. Tabs Conversation, Files, Log, plus Mail and Computer. Composer pinned to the bottom, run picker | Done in code (TV 5 Nov, TH 10 Nov) | `/threads/$sessionId`; `/tasks/$runId` redirects to it | `components/task/task-page.tsx`, `components/thread/*` (assistant-ui) |
| Live stream | Resumable SSE per session, partial text, reasoning, tool groups | Production | Conversation tab | `SessionStream` DO, `server/routes/session-stream.ts` |
| Main thread per agent | Each person has one main conversation per agent, plus pin, rename, archive, sub-threads | Done in code (TH) | Conversations card on the profile; New conversation | `profile/threads-card.tsx`, `svc/sessions.ts` |
| Conversation list | Every thread, filtered by agent, origin, text, working | Production | `/sessions`, Find only ("Conversations") | `routes/_app/sessions.tsx` |
| Stop, edit and resend, reply | Cancel a run, rewrite the last message, continue the session | Production | Thread page | `thread/user-edit-composer-container.tsx` |

### Desk and rail

| Capability | What it does | State | Where in the UI | Key code |
|---|---|---|---|---|
| Rail | Left column: Needs you (with Mine and Everyone), done today, pinned artifacts, Working, footer tabs | Production (footer RF.1 done in code) | Every signed-in page | `components/rail/*`, `svc/rail.ts`, `svc/rail/logic.ts` |
| Item pane | The open Needs you item with its decision buttons and "How it got here" | Production | `/desk?item=<id>` | `components/rail-pane/*` |
| Board | Three lanes: Needs you, Running, Done, with agent filter and mail strip | Production | `/desk?view=board`, Board button in the top bar | `components/desk/*`, `svc/desk.ts` |
| Setup items | "Add your AI account" and "Describe your first job" as Needs you rows | Production | Rail, new workspace | `rail-pane/setup-pane.tsx` |
| Find | Command palette listing every page and agent | Production | Top bar button, Ctrl or Cmd+K | `rail/find-registry.ts`, `find-dialog.tsx` |

### Approvals and questions

| Capability | What it does | State | Where in the UI | Key code |
|---|---|---|---|---|
| Requests | Three kinds: approval (allow once, always, deny), question, takeover. Approvals expire in 1 hour, mail approvals in 3 days, questions in 24 hours | Production | Rail and item pane, Board, inside the conversation, Slack cards | `svc/requests`, `run_requests`, `components/requests` |
| Other Needs you kinds | Skill, trigger and routine proposals, app permissions, library conflicts, wiki suggestions, inbox replies, A2A messages and connections, connector secrets, problems (failed runs, bounced mail) | Production | Rail and Board | `NEEDS_YOU_KINDS` in `packages/db/src/shared.ts` |
| Escalation | An item older than 4 hours also shows for the backup person | Production | Rail, "asked you too" | `svc/rail/logic.ts` |

### Subagents, delegation and connections

| Capability | What it does | State | Where in the UI | Key code |
|---|---|---|---|---|
| Hands to | An agent passes work to named other agents | Production | Works with row, Hands to sheet; wires on the Map | `profile/sheets/hands-to.tsx`, `agents.hands_to` |
| Subagents | Child runs of the same agent with their own model and narrowed access, at most 5 live, 2 levels | Done in code | Subagents switch in Works with; sub-threads on the thread page | `packages/mcp/src/tools/agents.ts`, `task/thread-relatives.tsx`, `docs/v3/subagents.md` |
| Agent connections (A2A 1.0) | Server and client. Invite links between Agentum deployments, access keys for outside callers, card URL for outside agents, pairing codes (Hermes), per-connection policies, revoke | Production (1 Nov) | `/settings/agent-connections` and `/$connectionId`; Works with on the profile; `/connect/$token` for an invite | `packages/a2a`, `svc/a2a`, `components/connections/*` |
| Teams | Named groups of agents or people, a lead agent | Absent. `docs/analysis/small-agent-teams.md` (18 Nov) is analysis only | none | none |

### Skills, memory, library, wiki

| Capability | What it does | State | Where in the UI | Key code |
|---|---|---|---|---|
| Skill store | Git-like store: commits, log, diff, revert, files, pin a version per agent | Production | `/skills`, `/skills/$skillId`, Find only; Skills row on the profile | `svc/skills-store`, `components/skills/*` |
| Skill approval | An agent proposes a version, a person approves or rejects | Production | Needs you; skill history | `skills-write.ts` tools, `skillStore.proposals` |
| Import and export | Import from GitHub or a bundle, export | Production | Add forms on `/skills` | `skills/import-github-form.tsx`, `skill_sources` |
| Memory and self-improvement | A memory store per agent | Absent. Skill proposals and wiki suggestions are the only ways an agent improves itself | none | none |
| Library | Workspace files in R2 with versions on every write, move, history, diff, conflicts | Production | `/library`, footer tab Files | `svc/library`, `library_entries`, `library_versions` |
| Sync and per-agent folders | Two-way sync onto machines and VMs, a home folder per agent, granted folders, a task output folder per run | Production (Managed uses tools only) | Library row on the profile; Files tab on a thread | `packages/library-sync`, `agent_library_access` |
| Wiki | Pages inside the library with versions and suggested edits | Production | `/library?wiki=<path>`, wiki tree on the Library page | `svc/wiki`, `components/library/wiki-*`, `wiki_suggestions` |
| Run files | Attachments in, output files out | Production | Composer, file chips, Files tab | `svc/files`, `files` |

### Artifacts and live artifacts

| Capability | What it does | State | Where in the UI | Key code |
|---|---|---|---|---|
| Artifacts | Agent-made pages, docs and dashboards with versions, sandboxed viewer, share links, access log, pins | Done in code (A tasks) | `/artifacts` (Find, "Things agents made"), `/a/$artifactId`, `/s/$token` for a share link, thread cards, pinned group in the rail | `svc/artifacts`, `components/artifacts/*` |
| Apps | Artifacts with server code, storage, approved hosts and secrets, public endpoints, agent hand-off, Endpoints and Source tabs | Done in code (B, EP, AL, DF.2) | Footer tab Apps (`/artifacts?kind=app`); tabs on `/a/$artifactId` | `packages/app-gateway`, `apps/hooks`, `artifact_grants`, `artifact_endpoints` |
| Live documents | Yjs and Tiptap documents edited by people and the agent together, comments, suggestions, mentions, export | Built, not accepted | Create document on `/artifacts`; `/a/$artifactId` | `components/live-artifacts/*`, `packages/live-doc`, `ArtifactRoom` DO |
| Live decks | Slide decks on the same model | Built, not accepted | Create deck on `/artifacts` | `components/live-decks/*`, `packages/live-deck` |
| Guests | Outside people invited by email to one artifact, one-time code, scoped agent runs | Built, not accepted (needs a security review, `docs/reviews/tasks/L.HANDOFF.md`) | Share dialog; guest page served outside the app shell | `svc/live-guests`, `components/guests/*`, `GuestRun` DO |

### Connectors, credentials and secrets

| Capability | What it does | State | Where in the UI | Key code |
|---|---|---|---|---|
| Connectors | Remote MCP servers by URL, with auth mode, tool allow-list and time limit | Production | `/settings/connectors` (Find hint "Apps"); Tools sheet on the profile | `svc/connectors`, `components/connectors/*` |
| Credential modes | `user_or_agent` (default), `agent`, `user`; OAuth or pasted credential, "Your credential" per person | Production | Connectors page, Tools sheet | `credentials`, `agent_connectors.credential_mode` |
| Secrets vault | Secrets as env values or proxy headers with egress placeholders, granted per agent | Production | `/settings/secrets`; Tools sheet | `svc/secrets`, `agent_secrets` |
| Platform MCP server | `/mcp` for outside clients: agents, sessions, inbox, library, wiki, skills, routines, triggers, Slack, artifacts, Q&A, agent management | Production (agent management MA.1 done in code) | none, used from Claude or other clients | `packages/mcp/src/tools/*`, `server/routes/mcp.ts` |
| API keys and connected apps | Keys and OAuth clients that reach `/mcp` | Production | `/settings/api-keys`, `/settings/connected-apps` | `svc/api-keys.ts`, `svc/oauth-clients.ts` |

### Starting work: triggers, routines, Slack, mail, forum

| Capability | What it does | State | Where in the UI | Key code |
|---|---|---|---|---|
| Web triggers | HTTP endpoints with a token that start a run | Production | `/triggers` (Find, "Web triggers"); Starts on sheet; Map | `svc/triggers.ts`, `triggers` |
| Routines | Cron schedules with a prompt and timezone | Production | `/routines` (Find, "Schedules"); Starts on sheet; Map | `svc/routines` |
| Slack apps | One Slack app per agent by manifest paste, threads, DMs, mentions, files, approval cards | Production | Channels sheet on the profile | `svc/slack`, `slack_apps`, `components/slack/*` |
| Agent email | One address per agent, inbound mail starts runs, outside mail waits for approval | Production | Address chip and mail sheet on the profile (`?mail=`), mail strip on the Board, Mail tab on a thread | `svc/mail`, `MailboxDO`, `agent_mailboxes` |
| Forum inbox | Threads where people and agents post, `@slug` wakes an agent, loop guard | Production | `/inbox` (Find, "Threads") | `svc/inbox`, `inbox_threads`, `inbox_posts` |
| Q&A board | Questions with answers from people or agents | Production | `/qa`, `/qa/$questionId` (Find, "Questions"); rail questions group | `svc/qa.ts`, `components/qa/*` |
| Map | n8n-style canvas of triggers, agents and outputs, with editing | Production | `/map`, Find only | `components/map/*`, `svc/map.ts`, `map_positions` |

### Computers and devices

| Capability | What it does | State | Where in the UI | Key code |
|---|---|---|---|---|
| Enrol a machine | One code, roles `agent_host`, `computer` or both, install script, doctor | Production | `/settings/machines` (Find, "Enrol a machine") | `components/machines/*`, `machine_enroll_tokens` |
| Computer use | Shell, files and desktop tools on an attached computer, browser tools | Production | Computer card and Browser switch on the profile | `packages/mcp/src/tools/computer.ts`, `browser.ts`, `svc/browser` |
| Desktop takeover | Live screen, a person takes control and hands back | Production | Computer panel or tab on the thread page; "You have control" in the rail | `components/computer/*`, `svc/takeover.ts` |
| Other hardware | Phones, IoT or other devices | Absent | none | none |

### Log, usage, workspace

| Capability | What it does | State | Where in the UI | Key code |
|---|---|---|---|---|
| Event log | Append-only events, filter by agent, type and dates | Production | `/log` (Find); Log tab on a thread | `svc/events`, `events`, `components/log/*` |
| Usage and cost | Cost per run and per agent per week | Production, partial. No workspace usage page, budgets or limits | Thread header; Cost column on `/agents` | `runs.usage`, `agents-table-logic.ts` |
| Workspaces | One Clerk organisation with a `workspaces` row; switch and create | Production | Workspace menu at the top of the rail; `/choose-organization` | `rail/workspace-menu.tsx`, `svc/workspaces.ts` |
| Members and invites | Invite by email with a role, members through Clerk's profile | Production (a real production invite is untested) | Workspace menu; `/accept-invitation` | `rail/invite-dialog.tsx` |
| Settings | Eight pages in three groups; admins only see the entry | Production | Footer tab Settings, workspace menu, Find | `components/settings/settings-nav.ts` |
| Workspace assistant | A chat that acts as the signed-in person through the MCP tools, with secret cards and confirm cards | Done in code (WA) | Assistant button in the top bar, `?assistant=` on any page | `components/assistant/*`, `svc/assistant` |
| Dictation | Speech to text in prompt boxes, paid by the workspace OpenRouter key | Done in code (DT) | Mic button in composers and prompt fields, Ctrl+D | `components/dictation/*`, `svc/dictation.ts` |

## 2. Current UI structure

### Navigation model

The shell is `web/routes/_app.tsx`: a top bar, the rail (320px), and a main pane.

- **Top bar**: Assistant, Board, Find (with the shortcut), New (New task, New agent), then the user button.
- **Rail, top to bottom**: workspace menu (switch, new workspace, invite people, members, settings), Mine and Everyone toggle, "You have control" when a takeover is held, Needs you, "N done today", questions, pinned artifacts, Working (three runs at most), footer tabs.
- **Footer tabs**: Agents, Apps, Files, and Settings for admins.
- **Find**: the only entry to Conversations, Log, Questions, Threads, Map, Schedules, Web triggers, Skills and all artifacts. `find-registry.test.ts` fails if a route is missing from it.
- **Panes and sheets**: the desk item pane (`?item=`), the assistant panel (`?assistant=`), profile sheets (`?sheet=`, `?mail=`), thread tabs (`?tab=`), library file and wiki (`?file=`, `?wiki=`), inbox thread (`?thread=`).
- **Phones**: the rail is a sheet, `/desk` shows the list inline, Settings opens an index page.

### Routes

| Route | What the page does |
|---|---|
| `/` | Landing page, or redirect into the app; lists workspaces when the active one has no row |
| `/login`, `/sign-up`, `/dev-login` | Clerk sign-in, sign-up, local dev login |
| `/choose-organization` | Pick one of the person's workspaces |
| `/accept-invitation` | Sign up or sign in from an invite, then Join |
| `/desk` | Item pane for the open Needs you item; `?view=board` shows the three-lane Board |
| `/agents` | Agents table, archived list |
| `/agents/new` | Builder: describe, draft, dry run, create; or start blank |
| `/agents/$agentId` | Agent profile with sheets |
| `/threads/$sessionId` | Thread page: conversation, files, log, mail, computer |
| `/tasks/$runId` | Redirect to the run's thread |
| `/sessions` | All conversations with filters |
| `/inbox` | Forum threads between people and agents |
| `/qa`, `/qa/$questionId` | Q&A board and one question |
| `/map` | Canvas of triggers, agents and outputs |
| `/routines` | Schedules for all agents |
| `/triggers` | Web triggers for all agents |
| `/skills`, `/skills/$skillId` | Skill list with add forms; one skill with editor, history, diff |
| `/library` | Files and wiki |
| `/artifacts` | Grid of artifacts with filters, Create deck, Create document |
| `/a/$artifactId` | Artifact viewer (outside the rail shell): versions, share, pin, Source, Endpoints, live editors |
| `/s/$token` | Anonymous share link view |
| `/connect/$token` | Agent connection invite |
| `/log` | Event log |
| `/assistant` | Redirect to the assistant panel |
| `/settings` | Index on phones, redirect to Model providers on desktop |
| `/settings/model-providers` | Anthropic and OpenRouter keys |
| `/settings/machines` | Enrol and list machines and computers |
| `/settings/connectors` | Connector registry and your credentials |
| `/settings/secrets` | Secrets vault |
| `/settings/artifacts` | Workspace artifact settings (link sharing) |
| `/settings/api-keys` | API keys for `/mcp` |
| `/settings/connected-apps` | OAuth clients |
| `/settings/agent-connections`, `/$connectionId` | A2A connections list and one connection |

### Main flows

**Create an agent.** New, New agent. Describe the job in a paragraph. The builder returns a draft (does, voice, tools, starts on, address). Run a dry run with a sample input. Create. A workspace with no model key gets an error that links to Settings, Model providers, and the description survives the trip. Model, runtime, environment and network sit behind Edit afterwards.

**Give it a task.** New, New task, pick the agent, write the task, send. The app opens the thread page. Or open the agent profile and use New conversation, or reply in an existing thread. Slack, mail, a trigger or a routine start tasks without the UI.

**Answer a request.** A row appears under Needs you in the rail. Click it, the item pane shows the card. Press Send reply, Allow once, Always allow or Deny, or answer the question. The pane moves to the next item. The same card also sits in the thread's conversation and in Slack.

**Connect a tool.** Settings, Connectors, Add connector: name, URL, auth mode. Connect your own credential (OAuth or paste). Then open the agent profile, Tools row, Manage, and assign the connector and its credential mode. A secret takes the same two steps through Settings, Secrets.

**Schedule something.** Either describe the schedule in the builder, or open the profile, Starts on, Manage, and add a routine. `/routines` (Find, "Schedules") lists all of them. The Map can also add a trigger by dragging.

**Look at files.** Footer tab Files opens the library: folders, file panel, history, wiki tree. A run's files are on the thread's Files tab. Agent-made pages are under Find, "Things agents made", and apps under the Apps tab.

## 3. Friction points

1. **Most pages have no visible entry.** Nine destinations exist only in Find: Conversations, Log, Questions, Threads, Map, Schedules, Web triggers, Skills, all artifacts. `CLAUDE.md` says so itself: "Find is the only way to reach most pages". A person has to know a page exists to search for it.
2. **Find names differ from page headings.** Find says Conversations, Threads, Questions, Schedules, Web triggers, Files and wiki, Things agents made. The pages say Conversations (route `/sessions`), Inbox, Q&A, Routines, Triggers, Library, Artifacts (`rail/find-registry.ts` against the `<h1>` in each route). "Thread" means a forum thread in Find and an agent conversation in the URL `/threads/$sessionId`.
3. **Four words for one conversation.** Task, run, session and thread all appear: New task, `/tasks/$runId`, `/sessions`, `/threads/$sessionId`, "Run 3 of 3". The Board lists runs, the profile lists Conversations and Recent tasks as two cards.
4. **Three places where a person is asked something.** Needs you, Q&A and Inbox (review.md, "What the app is today"). Only Needs you is in the rail by default.
5. **Three artifact entries.** Apps (footer), Things agents made (Find) and Settings, Artifacts. Documents and decks are created on `/artifacts`, which has no footer entry except through the Apps filter.
6. **Connecting a tool crosses four places.** Settings Connectors, Settings Secrets, the profile's Tools sheet and the Channels sheet (review.md). Settings is hidden from non-admins, yet "Your credential" lives on the Connectors page inside Settings.
7. **Starting work is split five ways.** Routines page, Triggers page, the Starts on sheet, the Map, and mail and Slack under Channels. Review direction C proposed one "job" sentence for this and it was not built.
8. **No app catalogue.** A connector is a name, a URL and an auth mode (review finding 3). Slack is a six-step manifest paste on another site (finding 4).
9. **A developer's first wall.** A new workspace needs an Anthropic key before anything works (finding 1). The rail now shows a setup item, but there is still no starter credit or guided key step.
10. **Plumbing words.** Connector, secret, proxy, env, runtime, isolate, trigger, routine, session, skill, artifact, machine, manifest, MCP (finding 16). The Edit sheet still asks for Runtime, Environment, Network access and Turn limit (`agent/agent-form.tsx`).
11. **The profile is dense.** Nine rows, five side cards, six sheets, a mail sheet and an Advanced disclosure on one page (`profile/profile-rows.tsx`, `agents.$agentId.tsx`). Settings for one agent sit in rows, cards and sheets with no single rule for which is which.
12. **Two homes.** `/desk` is the item pane, `/desk?view=board` is the Board. The Board repeats Needs you, and has its own New task and New agent buttons beside the top bar's New menu.
13. **The rail can only show work.** Its footer has room for four tabs, so every new feature lands in Find. The assistant, Board, Find and New sit in a separate top bar, so global actions are in two strips.
14. **Raw titles outside mail.** A run not started by mail keeps its raw input as a title, such as `{"harbourmaster_turn":{"artifact":...` (`rail/results.md`, limits).
15. **Done hides failure in words.** A run that ends with "I can't verify this" counts as done (`rail/results.md`). Only failed, interrupted and bounced work returns to Needs you.
16. **No timezone, no overall cost.** Schedules guess the timezone (finding 5). Cost shows per run and per agent week only.
17. **The artifact viewer leaves the shell.** `/a/$artifactId` is outside `_app`, so the rail and Find disappear while a person edits a document or deck.
18. **Count of concepts on day one.** A new admin can meet agents, tasks, conversations, the Board, the assistant, apps, files, wiki, skills, connectors, secrets, machines, model providers, triggers, routines, the Map, Inbox, Q&A, agent connections, API keys and connected apps: about twenty nouns before the first task finishes.

## 4. Data model summary

All tables carry `workspace_id` except `workspaces`. Schema files are in `packages/db/src/schema/`.

- `workspaces` (one per Clerk organisation), `identity_links` (Slack and other identities to users).
- `agents`: name, slug, instructions, soul, model, runtime, runtime_config, machine_id, computer_machine_id, owner and backup user, ask_level, hands_to, subagents, email_local, status (active, archived, draft).
- `agent_tool_rules`: per-agent ask-before rules per tool key.
- `sessions` (threads): agent, origin (ui, slack, mail, trigger, qa, a2a, artifact), title, private, pinned, archived, parent_session_id.
- `runs`: session, agent, status (queued, offered, running, waiting, done, failed, cancelled, interrupted), input, result, usage, parent_run_id, depth, subagent_level, on_behalf_of_user_id, dry_run, attention_cleared_at.
- `run_requests`: run, kind (approval, question, takeover), status, display, answer, answered_via (web, slack, a2a), expires_at.
- `events`: append-only log of everything, with sequence numbers.
- `files`: run attachments and outputs in R2.
- `machines`, `machine_enroll_tokens`, `machine_credentials` (roles agent_host and computer), `browser_sessions`.
- `workspace_model_keys`, `workspace_anthropic_keys`, `managed_agents`, `managed_sessions`, `managed_runs`, `managed_skills`.
- `connectors`, `credentials` (owner is a user or an agent), `agent_connectors` (credential mode, allowed tools), `oauth_states`.
- `secrets`, `agent_secrets`.
- `skills`, `skill_versions`, `skill_version_files`, `skill_assignments` (pin per agent), `skill_sources` (GitHub).
- `library_entries`, `library_versions`, `agent_library_access`, `library_conflicts`, `library_links`, `wiki_suggestions`.
- `triggers`: kind (http, routine, mail, app), agent, cron, timezone, prompt, token, proposal and approval fields.
- `slack_apps` (one per agent), `slack_threads`, `slack_messages`, `slack_events_seen`.
- `agent_mailboxes`, `mail_threads`, `mail_messages`.
- `inbox_threads`, `inbox_posts`; `qa_questions`, `qa_answers`.
- `artifacts`, `artifact_versions`, `artifact_version_files`, `artifact_shares`, `artifact_views` (access log and endpoint calls), `artifact_grants`, `artifact_pins`, `artifact_endpoints`.
- Live artifacts: `artifact_members`, `artifact_comment_threads`, `artifact_comments`, `artifact_live_changes`, `guest_identities`, `guest_invites`, `guest_sessions`, `guest_run_scopes`.
- A2A: `a2a_agent_cards`, `a2a_connections`, `a2a_pairing_requests`, `a2a_tasks`, `a2a_outbound_tasks`, `a2a_push_configs`, `a2a_outbox`.
- `api_keys`, `oauth_clients`; `assistant_conversations`, `assistant_messages`; `map_positions`.

Main relations: a workspace has agents. An agent has sessions, a session has runs, a run has events, requests, files and child runs. Connectors, secrets, skills and library folders are workspace objects granted to agents through join tables. Triggers, Slack apps and mailboxes belong to one agent and start runs. Artifacts belong to a workspace and link back to the run that made them.
