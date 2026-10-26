# Harbourmaster v2 build plan

Written 26 Oct 2026. Harbourmaster absorbs Agentum's and Trueforge's features and becomes Agentum v2, keeping its name. v2 is built straight onto `main`, one milestone after another, and each milestone ships to staging. The task files in `docs/tasks/V*.md` are the specs. This page holds the decisions, the rules that make parallel work possible, and each milestone's overview. `bun run tasks` shows what's ready.

Design references: the v2 design doc (https://claude.ai/artifact/YNcgwpPWmpqpGtQmeJ9er1) and the clickable unified view (https://claude.ai/artifact/AGViWKYAKKgQmZoCdQmkzY).

## Decisions

See "Dom's decisions for v2" in `docs/HANDOVER.md`. In short:
- the desk is home, each agent has a one-page profile and the map is a separate view, with no org chart
- chat runs on assistant-ui
- the wiki lives in the library, which gets live sync, per-agent folders, task output folders and versions
- each agent gets an email inbox based on agentic-inbox-hei
- approvals offer Allow once, Always allow and Deny, and mail to outside contacts needs approval by default

## Milestones

| Milestone | Goal | Tasks | On Codex |
|---|---|---|---|
| V0 | Set up the Codex lane, run a production smoke test | 2 | 0 |
| V1 | Runs that stream and can wait: event stream, `waiting` state, ask-user, tool approvals in web and Slack | 15 | 3 |
| V2 | Desk home and task view, with chat on assistant-ui | 14 | 4 |
| V3 | One-page agent profile, describe-then-review creation, dry run | 14 | 4 |
| V4 | Library and wiki: versions, folder access, live sync, task output folders, wiki pages | 21 | 8 |
| V5 | An email inbox per agent | 12 | 4 |
| V6 | Computers: Go client, desktop with take-over, browser, one machine registry | 16 | 6 |
| V7 | Map view, Q&A board, skill import from GitHub | 13 | 6 |
| Total | | 107 | 35 |

Milestones run in order. Each milestone's contract task depends on every task of the milestone before it. V1.1 also waits for V0.1 and for C.19, the secret scrub, which V1's stream and cards reuse. If Dom asks, a later milestone's backend-only task may start early.

## Rules for parallel work

- **The contract task comes first and runs alone.** `V<n>.1` holds the milestone's schema, migration, shared types, event shapes and protocol frames. No other task changes `packages/db/src/schema` or generates a migration, so parallel branches never fight over migration numbers.
- **Lanes:** every task has one `lane`, a file area: `db`, `services`, `worker`, `web`, `daemon`, `mcp`, `slack`, `computer`, `email`, `ops` or `docs`. Two tasks in the same lane never run at the same time. Their merges would conflict.
- **Concurrency:** at most 6 dispatchers at once, each with up to 4 Haiku workers, and at most 3 dispatchers driving a Codex job. `docs/workflow.md` has the loop.
- **Executors:** `executor: codex` marks tasks that are fully specified, provable by unit tests, and need no browser, migration, wrangler, secrets or deploy. A Sonnet dispatcher drives the Codex job and finishes or rescues it, and an Opus reviewer always reviews the code. Codex's own PASS lines are never taken as evidence. Everything else is `executor: claude`.
- **Codex runs unsandboxed,** inside throwaway worktrees under `harbourmaster-wt/`, through `scripts/codex-task.sh`, with a 90-minute cap (V0.1). The bwrap sandbox is broken on this host, and Dom chose to turn it off rather than have jobs hang.
- **Milestone gate:** tag `v<n>-start`, then an Opus milestone review against that milestone's section below. Must-fix findings become new tasks in the same milestone.
- **Refine before starting:** at each milestone's start, the controller reads its task files against the code as it is then, and tightens V2 to V7 scopes that earlier milestones changed.

## Decided on 26 Oct 2026

- Approvals expire after 1 hour and questions after 24 hours.
- A run not started in Slack sends its Slack cards as a DM to the person the run acts for.
- An agent reads only its home folder, `wiki/` and the folders granted to it.
- One mail domain serves all workspaces, so agent addresses are unique across workspaces (V3.1 and V5).
- V0.2: Dom approved the production deploy for the smoke test.

## Open questions for Dom (from the milestone drafts)

- V1: pasting each Slack app's manifest again by hand to turn on interactivity.
- V2: a task is one run, and a follow-up starts a new run (or should a task span the session?); "Edit and resend" starts a new run.
- V3: dry runs always run on Cloudflare; should "Hands to" limit `send_message`; should the Pause button come back.
- V4: keep versions 30 days, then the newest 20 per file.
- V5: should a list of company domains count as inside contacts.
- V6: how a computer-only machine fills `machines.credential_hash` without leaving a usable daemon credential.


## V1: Runs that stream and wait

Runs stop being black boxes that finish in jumps. Every session gets one live stream (a `SessionStream` Durable Object with resumable SSE and `Last-Event-ID`), fed by all three runtimes: PiRun through its stored events plus partial text, ManagedPoller and the machine daemon through the events they ingest. A run can now stop and ask a person: an `ask_user` question (or Claude Code's own `AskUserQuestion` on machines), or an approval for a tool the agent's "Ask me before" rules name, answered with Allow once, Always allow or Deny. The run sits in a new `waiting` state until someone answers on the web chat or through the agent's Slack app, where the first answer wins, or until the request expires. Everything a person sees in the stream, on a card or in Slack is the stored, C.19-scrubbed and masked form; nothing raw is streamed.

| id | title | lane | executor | size | depends_on | one line |
|---|---|---|---|---|---|---|
| V1.1 | Contract for streaming, waiting runs, requests and tool rules | db | claude | M | V0.1, V0.2 | `waiting` status, `run_requests` and `agent_tool_rules` tables, event types, stream frames, daemon request schemas |
| V1.2 | The waiting run state in the run lifecycle | services | claude | M | V1.1 | heartbeat, ingest, claim, complete, reaper, run tokens and Slack status understand `waiting` |
| V1.3 | Tool keys, the ask_user tool definition and answer texts | mcp | codex | S | V1.1 | pure functions shared by all runtimes: tool keys, `ask_user` schema, outcome texts |
| V1.4 | SessionStream Durable Object and the resumable SSE route | worker | claude | L | V1.1 | per-session SSE with replay from D1, fed by `onAppend` listeners |
| V1.5 | Requests and tool rules service with its tRPC router | services | codex | L | V1.2, V1.3, C.19 | open, answer (first wins), expire, cancel, rules, runtime wake-up port |
| V1.6 | Agent chat reads the session stream instead of polling | web | claude | M | V1.4 | EventSource reducer replaces the 1.5 s poll, poll kept as fallback |
| V1.7 | Slack Block Kit cards and interaction parsing for requests | slack | codex | S | V1.1, V1.3 | pure card builders and payload parser |
| V1.8 | PiRun streams the agent's partial text | worker | claude | S | V1.4, C.19 | throttled, masked `delta` frames from Pi's live view |
| V1.9 | Daemon request routes, managed wake-up and the expiry tick | worker | claude | M | V1.5 | machine routes to open and long-poll requests, minute expiry job |
| V1.10 | Cloud runs gate tool calls and ask questions in Pi | worker | claude | L | V1.5, V1.8 | replay-safe gate wrapper and `ask_user` Pi tool that survive eviction |
| V1.11 | Managed Agents runs wait for approvals and questions | services | claude | M | V1.5 | `always_ask` per ruled tool, `requires_action` to requests, `tool_confirmation` back |
| V1.12 | Machine runs gate tools and answer AskUserQuestion through the platform | daemon | claude | L | V1.3, V1.9 | spike hook vs canUseTool, then gate and AskUserQuestion via the routes |
| V1.13 | Requests posted and answered through the per-agent Slack apps | slack | claude | M | V1.5, V1.7 | interactivity route, cards in thread or DM, settle on any answer |
| V1.14 | Answer card in the agent chat and the "Ask me before" list | web | claude | M | V1.5, V1.6 | minimal web card and rule list on the settings tab |
| V1.15 | End-to-end staging check for streaming and waiting runs | worker | claude | M | V1.1 to V1.14 | all runtimes, both surfaces, expiry, cancel, scrubbing, on staging |

Codex: 3 of 15 (V1.3, V1.5, V1.7).

### Parallel waves
1. V1.1
2. V1.2 (services), V1.3 (mcp), V1.4 (worker)
3. V1.5 (services), V1.6 (web), V1.7 (slack), V1.8 (worker)
4. V1.9 (worker), V1.11 (services), V1.13 (slack), V1.14 (web)
5. V1.10 (worker), V1.12 (daemon)
6. V1.15

V1.5 and V1.8 also need C.19 merged (it is in progress on `task/C.19-transcript-secret-scrub`; V1 calls its `redactToolPayload` and `redactText` from `packages/services/src/events/scrub.ts`). V1.10 waits for V1.9 only because both are in the worker lane.

### Interplay with C.19
- The stream publishes the stored event record, so C.19's tool scrub and the run's masker have run before anything leaves the Worker (V1.4).
- Partial text deltas are masked and `redactText`-ed in the PiRun before publishing, and carry the whole partial text so a secret split across chunks is still caught. Tool arguments and output are never streamed as deltas (V1.8).
- Approval cards on the web and in Slack show `display.input`, scrubbed and masked when the request opens; the runtime keeps the raw input and never round-trips it (V1.5).
- Free-text answers are stored raw on the request row, because the runtime must hand them to the model, but go through `redactText` in the `request.answered` event; the model's later `tool.result` is scrubbed by C.19 as usual (V1.5).

### Milestone check (what Dom sees on staging)
On the agent chat page, a cloud agent's reply grows as it is written, and managed and machine runs update live without the 1.5 s jumps; reloading mid-run resumes cleanly. With "Ask me before" set on `bash`, each runtime pauses its run in `waiting`, an approval card with a scrubbed command appears on the chat page and in the agent's Slack thread or DM, and the first answer from either place wins while the other card settles. Allow once runs the call, Deny stops it and the agent says so, Always allow removes the rule. An agent's question with choices is answered the same way, and an unanswered request expires and the run goes on.

### Open questions for Dom
- Expiry defaults: approvals 1 hour, questions 24 hours. Change them, or make them per agent?
- Slack target for runs not started in Slack: DM the person the run acts for, if their Slack identity is linked. Is that right, or should it go to a fixed channel per agent?
- Every agent's Slack app needs its manifest pasted again for interactivity. Fine to do by hand for the staging agents?

## V2 Desk and task view

Make work the home page. The desk shows Needs you, Running and Done today over runs, inbox threads and pending approvals, and every card has a one-sentence status band. The navigation becomes Desk, Agents, Map, Library, Skills and Machines. Each run opens as a task: a receipt of steps built from its events, with in/out key chips and counts, a typed action log, the paused step's approval inline, and slots for Files (V4) and the live computer (V6). The chat is rebuilt on assistant-ui as the task's thread, with tool cards, reasoning, attachments and edit ported from trueforge's containers (Apache-2.0 files marked as modified). The old chat tab and its 1.5 s polling go away. V2 builds on V1's per-session live stream, `waiting` state, ask-user and approval cards.

| id | title | lane | executor | size | depends_on | one line |
|---|---|---|---|---|---|---|
| V2.1 | Desk and task view contract | db | claude | M | all V1 tasks | Shared enums and types, `message.reasoning`, desk indexes on `runs` |
| V2.2 | Receipt, action log and status band builders | services | codex | M | V2.1 | Pure `packages/services/src/tasks/` builders shared by server and browser |
| V2.3 | Reasoning events from Managed Agents | services | codex | S | V2.1, V2.2 | `managed/run-events.ts` keeps thinking |
| V2.4 | Reasoning events from cloud (Pi) | worker | claude | S | V2.1 | `pi-run-events.ts` keeps thinking parts |
| V2.5 | Reasoning events from machine runs | daemon | codex | S | V2.1 | `apps/daemon/src/normalize.ts` keeps thinking blocks |
| V2.6 | Fold session events into thread messages | mcp | codex | M | V2.1 | `@repo/protocol/thread` fold plus live-frame apply |
| V2.7 | Navigation restructure | web | claude | S | V2.1 | New sidebar, `/desk` and `/map` routes, More group |
| V2.8 | Desk service and tRPC | services | claude | M | V2.2, V2.3 | Three lanes and Needs you count in one call |
| V2.9 | Task service and tRPC | services | claude | M | V2.8 | One run with context, plus a recent-tasks list |
| V2.10 | Desk page | web | claude | M | V2.7, V2.8 | Lanes, bands, inline answers, New task |
| V2.11 | Task view page | web | claude | L | V2.2, V2.9, V2.10 | Live receipt, action log, inline approval, slots |
| V2.12 | Task thread on assistant-ui | web | claude | L | V2.4, V2.5, V2.6, V2.11 | Ported containers: tool cards, reasoning, attachments, edit |
| V2.13 | Retire the old chat tab | web | claude | S | V2.12 | Delete the chat tab and polling, repoint links |
| V2.14 | V2 end-to-end check on staging | web | claude | S | V2.13 | Three runtimes through desk, task and thread |

14 tasks, 4 on Codex (V2.2, V2.3, V2.5, V2.6).

### Parallel waves
1. V2.1
2. V2.2 (services), V2.4 (worker), V2.5 (daemon), V2.6 (mcp), V2.7 (web): five lanes at once
3. V2.3 (services)
4. V2.8 (services)
5. V2.9 (services), V2.10 (web)
6. V2.11 (web)
7. V2.12 (web)
8. V2.13 (web)
9. V2.14 (web)

The web lane is the critical path (V2.7, V2.10 to V2.14).

### Milestone check (what Dom sees on staging)
Signing in lands on the Desk. A cloud agent's task, started with "+ New task", appears in Running with a live band. It opens as a task with a receipt that grows step by step, counts between steps, an action log with thoughts and tool calls, and a thread where text streams in, tool calls show as grouped cards and reasoning folds away. When the agent asks for approval, the card shows in Needs you and on the paused step, and answering it on the web or in Slack moves the task on. Finished tasks from all three runtimes sit in Done today. The agent page no longer has a Chat tab.

### Open questions for Dom
- A task is one run. A follow-up message in the thread starts a new run, so the view moves to the new task and lists earlier runs as "Earlier in this thread". Is that the model you want, or should a task span the whole session?
- "Edit" resends the edited text as a new run. The agent still remembers the earlier message, because none of the runtimes can branch history today. Is that acceptable for V2?
- Inbox, Sessions, Log, Routines and Triggers sit in a collapsed "More" group until V3 and V7 absorb them. Is that the right interim place?

## V3 Agent profile and creation

Give each agent one plain-language profile and a friendlier way to make one. The profile replaces the eight tabs in `apps/web/src/components/agent/tabs/*` with a single page. It has a header (name, address, runtime, status), rows for Does, Voice, Tools, Skills, Hands to, Starts on, Channels and Library, and side cards for Runs on in plain words, "Ask me before it…" toggles bound to V1's approval rules, and Recent tasks. Voice and Hands to reach the prompts of all three runtimes. A new agent starts from a description: an LLM drafts the profile JSON from the workspace's existing connectors, skills and agents, gaps show as yellow chips, and an email address is reserved (the mailbox is V5's). A dry run on a sample reads for real and skips every write or send, and then "Create agent" activates it. Templates seed the description. The Library row is shown, and its per-folder enforcement is V4's.

| id | title | lane | executor | size | depends_on | one line |
|---|---|---|---|---|---|---|
| V3.1 | Profile and builder contract | db | claude | M | all V2 tasks | `soul`, `hands_to`, `email_local`, `draft` status, `runs.dry_run`, events |
| V3.2 | Profile read and ask-before service | services | claude | M | V3.1 | One call for every profile row; toggles over V1's rules |
| V3.3 | Voice and Hands to in prompts | services | codex | M | V3.1, V3.2 | Editable fields and `agentPrompt` for all three runtimes |
| V3.4 | Address reservation and draft agents | services | codex | S | V3.3 | Reserve the local part; draft, activate, discard |
| V3.5 | Builder draft schema, reconcile, gaps, templates | services | codex | M | V3.4 | Pure module: unknown ids become gaps, locked fields kept |
| V3.6 | Builder LLM draft service | services | claude | M | V3.5 | Anthropic call with a forced tool over the catalogue |
| V3.7 | Dry run and Create agent service | services | claude | M | V3.6 | Dry runs on the cloud isolate; create in one step |
| V3.8 | Dry-run gate in PiRun | worker | claude | M | V3.1 | Read tools run, other tools are skipped and logged |
| V3.9 | Dry-run gate in platform MCP tools | mcp | codex | S | V3.1 | Writing tools answer "would …" for dry runs |
| V3.10 | One-page profile | web | claude | L | V3.2, V3.3, V3.4 | Header, chip rows and Manage sheets; tabs removed |
| V3.11 | Profile side cards | web | claude | M | V3.10 | Runs on, Ask me before it…, Recent tasks, Computer slot |
| V3.12 | Builder page | web | claude | L | V3.6, V3.11 | Describe, voice, templates, import, review with gaps |
| V3.13 | Dry-run panel and Create agent | web | claude | M | V3.7, V3.8, V3.9, V3.12 | Sample chips, receipt of the dry run, create |
| V3.14 | V3 end-to-end check on staging | web | claude | S | V3.13 | Build, dry-run and create an agent; voice and toggles work |

14 tasks, 4 on Codex (V3.3, V3.4, V3.5, V3.9).

### Parallel waves
1. V3.1
2. V3.2 (services), V3.8 (worker), V3.9 (mcp): three lanes at once
3. V3.3 (services)
4. V3.4 (services), V3.10 (web)
5. V3.5 (services), V3.11 (web)
6. V3.6 (services)
7. V3.7 (services), V3.12 (web)
8. V3.13 (web)
9. V3.14 (web)

The services lane (V3.2 to V3.7) is the critical path.

### Milestone check (what Dom sees on staging)
"+ New agent" opens the builder. Dom describes the Researcher, picks "Careful, cites sources", and gets a drafted profile that uses only the workspace's own tools and skills. It has a yellow "Where it runs" chip and `research` reserved as its address. A dry run on a sample shows the reads it did and "Would write …" for the rest, and nothing appears in the library, Slack or the desk. "Create agent" opens the new one-page profile, with no tabs, every row filled and its side cards working. Changing the voice changes how the agent writes on all three runtimes, and turning on an "Ask me before it…" toggle makes the next matching tool call wait in Needs you.

### Open questions for Dom
- Which email domain will addresses use, one shared domain or one per workspace? V3 only reserves the local part, unique per workspace. A shared domain would need global uniqueness, which belongs in V3.1.
- Dry runs always run on Cloudflare (the isolate), because only there can every write be held back. Machine and managed agents get a dry run that is close to theirs, not identical. Is that acceptable?
- Hands to is stored and named in the prompt but not enforced: `send_message` can still reach any agent. Should V3 restrict it?
- The agent "Pause" button from the mock is left out, since there is no paused agent state today. Should it come in V3?

## V4 Library and wiki

The library becomes the shared, versioned workspace for files and the wiki. Every write keeps a version that people can compare and restore. Each agent gets folder access, read only or read and write, enforced in the library service and in what syncs to its machine. Machines and the Cloudflare VM sync live: a watcher or a periodic push sends edits within seconds, and the server announces changes so a running agent pulls them mid-run. Each task writes its files to `agents/<agent>/tasks/<id>/`, which replaces `[ATTACHMENT:]` markers and fills the task view's Files panel. Wiki pages are markdown files under `wiki/` with `[[links]]`, backlinks and broken-link marking. Agents suggest wiki edits, and those edits and sync conflicts land in Needs you. A spike settles whether Managed Agents can run the sync helper, and MCP tools cover them either way.

| id | title | lane | executor | size | depends_on | one line |
|---|---|---|---|---|---|---|
| V4.1 | Library and wiki contract | db | claude | L | all V3 | Tables for versions, access, conflicts, links and suggestions, the libraryPaths migration, live-sync frames |
| V4.2 | Versioned writes, compare, restore, retention | services | codex | M | V4.1 | Version row and blob on every write, restore, prune, change notifier hook |
| V4.3 | Per-agent folder access | services | codex | M | V4.2 | canReadAt/canWriteAt from grants, access API, sync scope with modes |
| V4.4 | library-sync read-only roots and targeted pulls | daemon | codex | M | V4.1 | Refuse pushes under read roots, `only` pulls, debouncer |
| V4.5 | Daemon live sync | daemon | claude | M | V4.4, V4.8 | Watcher pushes, `library_changed` pulls, no more markers |
| V4.6 | Change announcements and retention tick | worker | claude | M | V4.2, V4.3 | Notifier sends relay frames and PiRun RPCs, prune job |
| V4.7 | VM live sync | worker | claude | M | V4.4, V4.6, V4.8 | 30 s push and pull on announce in PiRun, task folder in prompts |
| V4.8 | Prompt: task folder replaces markers | mcp | codex | S | V4.1 | workspaceInstructions names the task folder and modes |
| V4.9 | Task output folders | services | claude | M | V4.3, V4.8 | Folder made at run start, taskFiles listing, managed prompt |
| V4.10 | Conflicts as records | services | codex | S | V4.3 | library_conflicts rows, resolve both ways, Needs you provider |
| V4.11 | Wiki service | services | codex | M | V4.2 | Ported link parsing, link index, backlinks, broken links, page tree |
| V4.12 | Wiki suggested edits | services | codex | M | V4.11, V4.3 | Suggest, accept, edit then accept, reject, stale |
| V4.13 | Library and wiki MCP tools | mcp | codex | M | V4.3, V4.12 | list/read/write/versions, wiki_read, wiki_suggest_edit |
| V4.14 | Spike: Managed Agents and the sync helper | docs | claude | S | V4.1 | Try a helper in the managed sandbox, write the decision |
| V4.15 | Library page: live, versions, move | web | claude | M | V4.2 | Live refresh, history, compare, restore, move and rename |
| V4.16 | Wiki pages UI | web | claude | M | V4.11, V4.15 | Page tree, links with broken marking, backlinks, edit, new page |
| V4.17 | Needs you: suggestions and conflicts | web | claude | M | V4.10, V4.12, V4.15 | Accept / Edit first / Reject, keep library or agent version |
| V4.18 | Task view Files panel | web | claude | S | V4.9 | Task folder live, outside edits, conflicts |
| V4.19 | Profile Library row | web | claude | S | V4.3 | Add folder, read only or read and write toggle |
| V4.20 | Slack files from the task folder | slack | claude | S | V4.9 | Post the run's task-folder files to the thread |
| V4.21 | Wiring and staging check | worker | claude | M | all V4 | MCP port adapters, compose, end-to-end on staging |

Codex: 8 of 21.

### Parallel waves
Lanes run one task at a time and at most 3 dispatchers run at once, so a wave lists what can run together, not what will.
1. V4.1
2. V4.2 (services), V4.4 (daemon), V4.8 (mcp), V4.14 (docs)
3. V4.3 (services), V4.5 (daemon), V4.15 (web)
4. V4.9 (services), V4.6 (worker), V4.19 (web)
5. V4.10 (services), V4.7 (worker), V4.18 (web), V4.20 (slack)
6. V4.11 (services)
7. V4.12 (services), V4.16 (web)
8. V4.13 (mcp), V4.17 (web)
9. V4.21

Widest wave: 4.

### Milestone check (what Dom sees on staging)
An agent on the office machine edits a file and it appears on the library page within seconds; Dom edits a file the agent uses and the agent picks up the change in the same run. The VM agent does the same. A file both edited at once shows as a conflict card in Needs you, and Dom keeps either version. The agent profile's Library row sets folders to read only or read and write, and a read-only folder refuses the agent's write. A task's files sit in `agents/<agent>/tasks/<id>/` and show in the task view's Files panel. Every file and wiki page has a history with compare and restore, and folders can be moved and renamed. Wiki pages link with `[[...]]`, missing targets show red, and backlinks list who links in. An agent's suggested wiki edit waits in Needs you until Dom accepts it.

### Open questions for Dom
- Reads outside an agent's grants are refused (home, `wiki/` and granted folders only). Existing agents keep their `libraryPaths` as read-and-write grants. Is losing read access to the rest of the library right, or should every agent read everything by default?
- Retention: every version for 30 days, then the newest 20 per file. OK?

## V5 Agent email

Each agent gets its own email address, built on Dom's agentic-inbox-hei. A spike first decides whether the inbox runs as a module inside harbourmaster's Worker or as a separate Worker reached by a service binding. Addresses are provisioned on Cloudflare Email Routing. Mail to an agent is a trigger: a new thread starts a session and a task, and replies continue them. Agents send and reply with MCP tools, and mail to outside contacts waits for a person through V1 approvals. People see mail on the agent profile's Mail tab, on the desk's mail strip and in the task view, where each thread is linked to its task. A real email on staging closes the milestone.

| id | title | lane | executor | size | depends_on | one line |
|---|---|---|---|---|---|---|
| V5.2 | Spike: module or service-bound Worker | docs | claude | S | all V4 | Read agentic-inbox-hei and its plans, write the decision and the port list |
| V5.1 | Agent email contract | db | claude | M | all V4, V5.2 | Mailboxes, threads, messages, mail trigger, approval kind, ports |
| V5.3 | Mailbox per agent and provisioning | services | codex | M | V5.1 | Address choice, routing rule, status, new agents get one |
| V5.4 | Inbound mail starts a run | services | codex | M | V5.3 | Thread to session and task, attachments to the task folder, loop guard, bounces |
| V5.5 | Send and reply with approvals | services | codex | M | V5.3 | Outside contacts held for V1 approval, allow, always allow, deny, expiry |
| V5.6 | Mailbox backend | email | claude | L | V5.1, V5.2 | MailboxPort on agentic-inbox-hei, per the decision |
| V5.7 | Worker wiring | worker | claude | M | V5.3, V5.4, V5.5, V5.6 | Inbound entry point, bindings in three places, Email Routing adapter, compose |
| V5.8 | MCP mail tools | mcp | codex | S | V5.1 | mail_list, mail_read, mail_send, mail_reply |
| V5.9 | Profile Mail tab | web | claude | M | V5.4, V5.5 | Address and status, threads, mail trigger switch |
| V5.10 | Desk mail strip and approval card | web | claude | S | V5.5 | Per-address counts, mail fields on the approval card |
| V5.11 | Task view mail thread | web | claude | S | V5.4 | Trigger step and thread card in the task view |
| V5.12 | Staging check with a real email | worker | claude | M | all V5 | Gmail in, held reply, approve, reply continues the session |

Codex: 4 of 12.

### Parallel waves
1. V5.2 (the spike runs first; the contract waits for its decision)
2. V5.1
3. V5.3 (services), V5.6 (email), V5.8 (mcp)
4. V5.4 (services), V5.6 continues
5. V5.5 (services), V5.11 (web)
6. V5.7 (worker), V5.9 (web)
7. V5.10 (web)
8. V5.12

Widest wave: 3.

### Milestone check (what Dom sees on staging)
Each agent's profile shows its own address. Dom emails an agent from Gmail and a task starts, linked to the mail thread. The agent replies to Dom's outside address, and the reply waits in Needs you with from, to and subject; Allow once delivers it to Gmail. Dom's answer continues the same session and task. The desk's mail strip counts mail in and held per address, the Mail tab lists the threads, and a bounced mail shows on its task.

### Note for the integrator
V5.1 is the contract, as the rules require, but it depends on the V5.2 spike, because the port shape comes from the decision. The controller dispatches V5.2 first.

### Open questions for Dom
- One mail domain for all workspaces (addresses unique across the deployment, so V3's per-workspace uniqueness is not enough) or a domain per workspace?
- Who counts as inside: same-workspace agents and members' emails only, or also a list of company domains?

## V6 Computers

Cloud and managed agents get a real computer: agentum's Go client and frozen protocol v1, ported into Harbourmaster's own machine registry. One machine can run the agent loop through the existing daemon, act as a computer for a cloud or managed agent, or do both. The relay is one Durable Object per machine (`MachineRelay`, sockets tagged daemon, computer and viewer). A person watches the desktop live in the task view, from JPEG frames pushed over a WebSocket. Agents ask for a take-over, and the request lands in Needs you and Slack. Every agent also gets a browser on Cloudflare Browser Run. Fly and Podman are out of scope; Podman gets one untested README line.

| id | title | lane | executor | size | depends_on | one line |
|---|---|---|---|---|---|---|
| V6.1 | Computer contract, machine roles, protocol v1, relay decision | db | claude | L | all V5 | Schema, enrol roles, protocol v1 port with golden fixtures, one-DO decision |
| V6.2 | Port the Go computer client | computer | codex | L | V6.1 | `apps/computer` as `hm-computer`, enrols and dials HM routes, v1 unchanged |
| V6.3 | Docker images, ghcr workflow | computer | claude | M | V6.2 | Headless and desktop images, `workflow_dispatch` publish |
| V6.4 | Machine roles in the machines service | services | codex | M | V6.1 | Role-scoped enrol and auth, computer presence, attach to agent |
| V6.5 | Computer and browser MCP tools | mcp | codex | L | V6.1 | `computer_*`, `desktop_input`, `browser_*`, takeover tool, prompt paragraph |
| V6.6 | Browser service | services | codex | M | V6.1 | Rules, snapshot, session reuse, screenshots into the task folder |
| V6.7 | Take-over requests | services | codex | M | V6.1 | Pending request of kind takeover, take, hand back, cancel, resume |
| V6.8 | Slack take-over ping | slack | codex | S | V6.1 | Card with an Open screen link, updated on settle |
| V6.9 | Computer sockets in MachineRelay | worker | claude | L | V6.1, V6.4 | Relay core port, tagged sockets, `/api/machines/computer` |
| V6.10 | Viewer hub and desktop routes | worker | claude | L | V6.9, V6.7 | JPEG push, lease, take control, hand back |
| V6.11 | Wire ports, Browser Run binding | worker | claude | M | V6.5, V6.6, V6.9 | Computer and browser ports, `BROWSER` binding, compose |
| V6.12 | Managed agents' computer | services | claude | M | V6.4, V6.5 | `desktop_screenshot` custom tool, session retire on change |
| V6.13 | Cloud agents' computer | worker | claude | M | V6.7, V6.11, V6.12 | Pi image tool, prompt, takeover resume, managed wiring |
| V6.14 | Machines page and Computer card | web | claude | M | V6.4 | Enrol per role, docker commands, attach on profile |
| V6.15 | Live screen panel | web | claude | L | V6.10, V6.14 | Screen in task view, take over, I'm done, Needs you card |
| V6.16 | Computers on staging | worker | claude | M | all V6 | End-to-end walkthrough |

Codex: 6 of 16 (V6.2, V6.4, V6.5, V6.6, V6.7, V6.8).

### Parallel waves
1. V6.1
2. V6.2 (computer), V6.4 (services), V6.5 (mcp), V6.8 (slack)
3. V6.3 (computer), V6.6 (services), V6.9 (worker), V6.14 (web)
4. V6.7 (services), V6.11 (worker, after V6.9)
5. V6.12 (services), V6.10 (worker)
6. V6.13 (worker), V6.15 (web)
7. V6.16

Lanes serialise services (V6.4, V6.6, V6.7, V6.12) and worker (V6.9, V6.10, V6.11, V6.13). The order inside a lane can follow readiness.

### Milestone check (Dom on staging)
Dom starts the desktop image with `docker run` and adds the computer role to his daemon machine. Both show on the Machines page with a status for each role. He attaches a computer to a cloud agent and a managed agent. Each one opens Chromium and describes a screenshot. One asks for a take-over: the card shows in Needs you, Slack links to the screen, Dom takes over in the task view, types, and clicks I'm done with a note, and the agent carries on. A browser tool run on Browser Run leaves its screenshot in the task's Files panel. Revoking the machine closes both roles.

## V7 Map, Q&A board and skill import

The last v2 milestone adds the designer view and the remaining Trueforge and master-control features. The map shows who starts what, who hands to whom, and where results go. Runs mode comes first, with 7-day wire counts from events and hand-offs, a yellow waiting node and an inspector. Editor mode follows, and it writes the same config as the agent profile. A Q&A board lets agents (through MCP tools) and people ask and answer, on D1. Skills import from a GitHub URL pinned to a commit, with update notices that become proposed versions. A final staging walkthrough covers all of v2. A supervisor agent and WhatsApp stay out.

| id | title | lane | executor | size | depends_on | one line |
|---|---|---|---|---|---|---|
| V7.1 | Map, Q&A and GitHub skill source contract | db | claude | M | all V6 | Q&A tables, skill source, map positions, graph types, events |
| V7.2 | Map graph service | services | codex | M | V7.1 | Nodes, wires and 7-day counts from events, waiting flag |
| V7.3 | Map Runs mode with inspector | web | claude | L | V7.2 | `@xyflow/react` canvas, counts, yellow waiting node, inspector |
| V7.4 | Map editor service | services | codex | S | V7.2 | Connect triggers, plug tools, save positions via profile services |
| V7.5 | Map Editor mode | web | claude | L | V7.3, V7.4 | Drag, wire, plug, + Trigger, + Agent |
| V7.6 | Q&A board service | services | codex | M | V7.1 | Ask, answer, accept, wake the asking agent |
| V7.7 | Q&A MCP tools | mcp | codex | S | V7.1 | `qa_ask`, `qa_list`, `qa_read`, `qa_answer` |
| V7.8 | Q&A board pages | web | claude | M | V7.6 | `/qa` list and question pages |
| V7.9 | GitHub skill fetcher | worker | codex | M | V7.1 | Ref to sha, tarball, subfolder, limits |
| V7.10 | GitHub skill import and update check | services | codex | M | V7.1 | Pinned import, update notice, update as proposed version |
| V7.11 | Import form and update notice | web | claude | M | V7.10 | Import from GitHub, source line, Review update |
| V7.12 | Wire Q&A ports, fetcher, update tick | worker | claude | S | V7.6, V7.7, V7.9, V7.10 | MCP port, compose, tick job |
| V7.13 | v2 final staging walkthrough | web | claude | M | all V7 | Every v2 area checked on staging |

Codex: 6 of 13 (V7.2, V7.4, V7.6, V7.7, V7.9, V7.10).

### Parallel waves
1. V7.1
2. V7.2 (services), V7.7 (mcp), V7.9 (worker)
3. V7.6 (services), V7.3 (web)
4. V7.10 (services), V7.8 (web)
5. V7.4 (services), V7.12 (worker), V7.11 (web)
6. V7.5 (web)
7. V7.13

The services lane (V7.2, V7.6, V7.10, V7.4) is the long pole. The order inside it can follow what the web lane needs next.

### Milestone check (Dom on staging)
Dom opens the map. Triggers, agents and outputs show with 7-day counts on the wires, and an agent waiting on an approval is yellow. Clicking it opens the inspector, where he approves inline. In Editor mode he wires a schedule trigger to an agent and plugs the browser into it, and both show on the agent's profile. An agent asks on the Q&A board, Dom answers, and the agent is woken with the answer. He imports a skill from a GitHub URL, sees the pinned commit, and after an upstream push the update notice turns into a proposed version in Needs you. Then the V7.13 walkthrough passes for all of v2.
