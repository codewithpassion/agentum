# Agentum v4 build plan: the Roster

Written 19 Nov 2026. v4 rearranges the app around agents. Home becomes a wall of agent cards, each agent gets one page with seven tabs, agents get memory and a nightly dream, and agents form teams with a room that links to a Slack channel. Most of the machinery exists. The work is regrouping it, plus three new builds: memory, dreams and teams.

The task files in `docs/tasks/` with the prefixes NV, RH, KY, JB, ME, DR, SP, TM, SL, TX and FR are the specs. This page holds the decisions, the rules that let the tasks run in parallel, and each milestone's overview. `bun run tasks` shows what is ready.

Design references, all in `docs/research/ui-reimagine-2026-11/`:

- `report.html`: the research, the three proposals, the mockups and the gap map. Also published at https://agentumbot.io/a/8aa75f3b-9d58-4cc2-ba36-b2301b41c6e8.
- `memory-and-dreaming.md`: the memory and dream design.
- `agentum-inventory.md`: what exists today, with code paths.
- `indydevdan-transcript-notes.md`: the team features the lead role and rooms borrow from.

## Decisions

Dom, 19 Nov 2026.

| Question | Decision |
|---|---|
| Shell | The Roster: agent cards on home, one agent page with tabs |
| Teams | A team has a lead, members and a team room. No org chart |
| Slack | One Slack app per agent stays. One Slack channel maps to exactly one team room |
| Lead listening | A room message that names nobody goes to the lead, with a switch to turn it off |
| Lead powers | The lead proposes changes to its members. The member's owner approves. The lead never writes them |
| Learning default | Notes: "Tell me after". Skill changes: always ask |
| Memory store | Files in the agent's library home folder |
| Dreams | Built into Agentum. No call to The Brain as a service. Code may be copied from `the-brain/packages/db/src/dream/` |
| Private conversations | A dream may read them. The notes stay with that person unless they approve sharing |
| Wording | "Team", "lead" and "owner". No staff or hiring language |
| Two teams | An agent may be in several teams, with one home team |

These replace the v2 decisions "the desk is home" and "no teams". The other v2 and v1 decisions hold.

## Vocabulary

NV.1 applies this table to the web app. Later milestones finish it.

| The user sees | It covers | Done in |
|---|---|---|
| Agent | The agent, its voice, owner, address and where it runs | RH |
| Conversation | A session or agent thread | NV.1 |
| Task | A run inside a conversation | NV.1 |
| Team, team room, topic | The team object, the forum inbox, an inbox thread | TM |
| Job | Routines, web triggers, mail and Slack starts | JB |
| Keys | Connectors, sign-ins, secrets, other agents, ask-before rules | KY |
| Knows | Instructions, skills, memory, the dream diary | ME, DR |
| Files | Library, task files, artifacts, apps | RH.4 |
| Cloud, Anthropic cloud, My computer | The `cloud`, `managed` and `machine` runtimes | NV.2 |

Routes, tables and tRPC names keep their current names. Only what a person reads changes.

## Rules for parallel work

`docs/workflow.md` still governs roles, briefs, worktrees and merging. These rules are added for v4.

1. **Contract tasks own the shared files.** Each milestone except NV and FR starts with a contract task, `<M>.1`, in the lane `contract`. Only a contract task changes `packages/db/src/schema`, migrations, `packages/db/src/shared.ts`, `apps/web/src/server/compose.ts` and `apps/web/src/server/trpc/router.ts`. It creates the service module and the tRPC router with final types and stub bodies. One `contract` lane means contract tasks run one at a time, so migration numbers never collide.
2. **Everything else in a milestone depends on the contract, not on its siblings, wherever it can.** Service, MCP and web tasks build against the stubs at the same time. A web task that needs real data for its browser check uses the stub's fixture or seeds the database.
3. **A lane is a set of files.** Two tasks in one lane never run at once. The lanes below are chosen so that tasks in different lanes touch disjoint files.
4. **Each milestone ends with an e2e task** in the lane `e2e`. It runs the whole flow against real services and files what the parallel tasks missed. Small fixes go in the e2e branch. Larger ones become new tasks.
5. **Two files still collide.** `apps/web/src/components/rail/find-registry.ts` gets one line per new page, and `apps/web/src/routeTree.gen.ts` is generated. A dispatcher that merges `main` resolves the first by keeping both lines and the second by regenerating it.
6. **A new tab lives in its own folder.** RH.4 creates `components/agent/room/<tab>/`. KY.5, JB.4, ME.6 and DR.6 each work only inside their tab's folder.
7. **Codex tasks never touch schema, wrangler config or the browser.** 17 of the 71 tasks are `executor: codex`. They are service and tool tasks with a test-only check.
8. **Milestone gates** follow `docs/workflow.md`, with this file as the plan the reviewer reads.

### Lanes

| Lane | Files |
|---|---|
| `contract` | `packages/db/src/schema`, migrations, `packages/db/src/shared.ts`, `compose.ts`, tRPC root, new service and router skeletons |
| `web-shell` | `routes/_app.tsx`, `components/shell`, `components/rail`, `find-registry.ts` labels, redirects |
| `web-home` | `routes/_app/home.tsx`, `components/roster` |
| `web-agent` | `routes/_app/agents.$agentId.tsx`, `components/agent` outside the tab folders, `components/agent/room/now` |
| `web-keys`, `web-jobs`, `web-knows` | One tab folder each under `components/agent/room/`, plus `/jobs` for `web-jobs` |
| `web-team` | `routes/_app/teams.$teamId.tsx`, `components/team` |
| `web-room` | The room route, `components/room`, `components/inbox` |
| `web-thread` | `components/thread`, `components/task` |
| `web-requests` | `components/requests`, `components/rail-pane` cards |
| `web-spend`, `web-settings`, `web-builder` | `/spend`, settings pages, `components/agent/builder` |
| `services-<name>` | One service folder or file under `packages/services/src`, named in the task |
| `builder` | `packages/services/src/agent-builder`, `jobs` drafting |
| `mcp` | `packages/mcp/src/tools` |
| `runtimes` | `cloud/runtime.ts`, `managed`, `runs/machine-claim.ts`, the client's launch arguments |
| `worker` | `apps/web/src/server` routes, crons and Durable Objects |
| `slack` | `packages/services/src/slack`, `routes/slack.ts` |
| `daemon` | `apps/agentum` |
| `e2e` | Walkthroughs and `docs/reviews/<M>-e2e.md` |

## Milestones

| Milestone | Goal | Tasks | On Codex | Needs |
|---|---|---|---|---|
| NV | One word per thing, readable titles, a waiting question no longer blocks an agent | 4 | 1 | nothing |
| RH | The Roster home, the agent room with seven tabs, one top bar | 7 | 1 | NV.1, NV.2 |
| KY | Keys tab, own sign-ins for every member, app catalogue | 7 | 3 | RH.4 for the tab |
| JB | Every start as a sentence, describe a job, the Jobs tab and page | 5 | 2 | RH.4 for the tab |
| ME | Memory files, remember rules, agent tools, the Knows tab | 9 | 3 | RH.4 for the tab, RH.2 |
| DR | The dream: steps ported from The Brain, schedule, diary, undo | 7 | 2 | ME |
| SP | Spend page, weekly caps, pause and resume | 5 | 1 | RH.4, RH.6 for the UI |
| TM | Teams, team rooms with topics, lead role, effort per agent | 10 | 1 | RH.3, RH.4, RH.6 for the UI |
| SL | One Slack channel per team room, mirrored both ways | 5 | 0 | TM |
| TX | Team dream and team memory, lead-run discussions, decision queue | 7 | 1 | TM, DR, SL.3 |
| FR | Templates, team starters, first-run guide | 5 | 2 | RH.3, TM.4 |

71 tasks.

## What runs when

Eleven tasks are ready on day one: NV.1, NV.2, NV.3, NV.4, FR.1, and the contracts RH.1, KY.1, JB.1, ME.1, SP.1 and TM.1. The six contracts share a lane and run back to back. Start them in that order, because RH.1 unblocks the most.

**Wave 1.** NV.1 (web-shell), NV.2 (web-agent), NV.3 and NV.4 run together with the contract queue and FR.1. As each contract lands, its service tasks open: RH.2, KY.2, KY.3, KY.4, JB.2, JB.3, ME.2, ME.4, SP.2, TM.2, TM.5. All sit in different lanes, so the limit is the six dispatcher slots and three Codex slots, not the task graph.

**Wave 2.** RH.3 (home) follows NV.1, and RH.4 (agent room) follows NV.2. RH.4 is the gate for every tab: KY.5, JB.4, ME.6, SP.4 and TM.6 open when it merges. ME.3, ME.5, SP.3 and TM.3 follow their service tasks. TM.7 (room UI) needs only TM.1 and can start early.

**Wave 3.** DR starts when ME.2 and ME.3 are in: DR.1, then DR.2 and DR.3 side by side, then DR.4. SL starts when TM.3 is in. RH.5, RH.6, TM.8 and TM.9 finish the shell.

**Wave 4.** TX needs TM.4, DR.4 and SL.3. FR.2 needs TM.4. The e2e tasks close each milestone as its last task merges.

The longest chain is ME.1, ME.2, ME.3, DR.4, TX.2, TX.6, TX.7. Keep it moving first when slots are short. The second is NV.2, RH.4, then any tab.

Lanes that queue more than one task: `contract` (9), `e2e` (10), `web-agent` (3), `web-home` (3), `web-shell` (3), `slack` (3), `services-dream` (3), `builder` (3).

## Milestone overviews

**NV, vocabulary.** NV.1 renames what people read and makes Find labels match page headings. NV.2 turns the runtime into three plain choices and hides the plumbing under Advanced. NV.3 stops raw JSON showing as a conversation title. NV.4 fixes the defect where an unanswered question holds a machine agent for a day. Cards and rooms depend on that fix to show honest state.

**RH, Roster home.** RH.2 computes one status line per agent from runs, requests and routines. RH.3 is the card wall. RH.4 turns the profile into a header and seven tabs and moves today's rows, cards and sheets into them without changing behaviour. RH.5 adds the Right now panel. RH.6 replaces the rail and top bar with one top bar and a Needs you drawer.

**KY, Keys.** One read model joins connectors, sign-ins, secrets, mail and Slack identity, other agents and ask-before rules. Members manage their own sign-ins without Settings. A small catalogue creates a connector from a name.

**JB, Jobs.** One read model lists every start as a sentence. A person describes a job and reviews a draft. `/jobs` replaces `/routines` and `/triggers`.

**ME, Memory.** Notes are files in `agents/<slug>/memory/`, written only by the memory service, with a `memory_changes` row per change. The owner sets Remember and Never lists and a learn level. Agents get `remember` and `search_history`. Notes load into the prompt on all three runtimes. Private notes stay with their person.

**DR, Dream.** A scheduled run per agent collects what happened, extracts candidate notes, merges, reconciles and prunes with steps ported from The Brain, writes one new version and a diary, and can be undone. Repeated procedures become skill proposals.

**SP, Spend.** Rollups from run usage, a weekly cap per agent and per workspace, and a pause that asks the owner.

**TM, Teams.** Teams, members and a lead. The forum inbox becomes team rooms with topics, full catch-up on mention, editable team rules above the untrusted block, and a lead that hears unaddressed messages. The lead gets team tools and proposes changes for owners to approve. Agents get a thinking level and context size.

**SL, Slack link.** One channel per team room. Each message is recorded once although every member app hears it. Room posts go out through the posting agent's app.

**TX, Team extras.** The team dream settles conflicts between members and lifts shared facts into team memory. The lead can run a bounded discussion. Any agent can raise several decisions as one card, in the app and in Slack.

**FR, First run.** Agent templates, two team starters, a guided key step on the home page, and a timed walkthrough from a clean database.

## Assumptions in the task files

Each is a default I chose where the report did not say. Change the task file if Dom decides otherwise.

- A lead is restricted to team tools only in runs woken by its team room. In its own conversations it works as a normal agent (TM.4).
- Existing inbox threads move to a team named "Everyone" with no lead (TM.1).
- The dream runs at 02:00 workspace time, and the team diary posts to Slack at 08:00 (DR.4, TX.6).
- The memory section of a prompt is capped at 6,000 characters (ME.5).
- A lead-run discussion has at most five rounds (TX.3). A decision queue has at most eight questions (TX.4).
- The catalogue starts with at most ten apps that document a remote MCP endpoint (KY.4).

## Not in this plan

- Starter credit for new workspaces. That is a billing decision.
- Hardware beyond enrolled computers.
- Folding the Q&A board into rooms. It stays as it is and stays in Find.
- Moving the artifact viewer `/a/$artifactId` into the shell.
- The Map. It stays as it is and stays in Find.
- The open live artifact tasks (L, LD, LG, LX) and RC.7, CL.7, LR.17. They are independent of v4.

## Before the controller starts

- `workspaces.timezone` exists already. The inventory said it did not. JB.1 only adds the setting.
- `docs/HANDOVER.md` still points at `docs/v2/build-plan.md` as the place to start. Update it when v4 work begins.
