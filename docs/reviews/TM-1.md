# TM gate review, round 1

Range: `git diff tm-start..934dfca49d4cb23f41ad67cf0688406b07ce39ab`. The range holds 814 commits from several milestones that ran in parallel, 104 of them TM commits. I reviewed the TM files as they stand at 934dfca4: `packages/services/src/teams.ts`, `teams/`, `inbox.ts`, `inbox/`, the team tools in `packages/mcp/src/tools/team.ts` and `server.ts`, the room-run cut in `runs/launch-context.ts`, the proposal checks in `requests.ts`, `routes/mcp.ts`, and the web code in `components/team`, `components/room` and the team routes. I judged non-TM commits only where they touch teams, rooms, topics, the lead, proposals or team spend: TX.3 discussions, TX.2 team memory and digest, SL room intake and outbound, ME.14 private notes, and the desk's room items.

I judged it against the TM section of `docs/v4/build-plan.md`, the task files `docs/tasks/TM.1` to `TM.11`, `CLAUDE.md` in the checkout, "Rules that are easy to break" in `docs/HANDOVER.md`, `docs/reviews/TM-e2e.md` and the per-task reviews in `docs/reviews/tasks/TM.*`. TM.12 to TM.18 are open follow-ups, and nothing below repeats them.

I ran the teams, inbox, room-access, wake-input, loop-guard, post-links and lead service tests (167 pass, `services-tests.log`) and the MCP team tool tests (19 pass). I also wrote two probe tests on the `inbox.test.ts` harness. Their source is `probe-tests.ts` and their output is `probe-output.txt`, both in this folder. The probe file was removed from the worktree afterwards.

## Verdict

Not clean. Five must-fix findings.

Two of them are about who can steer an agent. Any workspace member can create a team, put another owner's agent in it, make it the lead and write team rules. Those rules reach the agent as trusted instructions, and its team's notes load into every run it does. The lead's room run is cut to team tools only in the MCP list. The runtimes' own shell, file and web tools stay on, on all three runtimes. The plan asks for a tool restriction in the run's tool list.

The other three are leaks and gaps in the room itself. An archived team's room still takes posts and wakes its agents with the team's rules. A person's private notes reach a room run when an agent posts into the room from that person's private conversation, and the reply lands in the shared topic. A room lists only those of its topics that are among the workspace's 50 most recent, so a quiet team's room shows up empty once other teams are busy.

Several things hold up. Limited topics stay hidden on every path I followed (`listThreads`, `readThread`, the desk, sessions, Slack outbound, room search, the team digest and dream collection, notices and discussions). Proposals are answered only by the member's owner or an admin, Always allow is refused, and the strict schema keeps access, keys, ask-before rules and connectors out. Agent loops are bounded: three agent posts in a row stop a topic, an agent gets ten room wakes an hour, a wake chain stops at depth 3, a busy ancestor refuses, the lead hears only people, and discussion wakes cannot chain. The HANDOVER and CLAUDE.md rules hold in the TM files: no `env` reads in services, multi-statement writes go through `atomic`, every new table has `workspace_id`, and no web component imports a schema module.

## Findings

| # | Severity | Finding | Area | Resolution |
|---|---|---|---|---|
| 1 | must-fix | `teams.addMember` adds any active agent without its owner's consent, and so does `teams.create` with `leadAgentId`. Any workspace member can create a team and become its owner (`requireOwner` passes for the creator). From there they can add another owner's agent, make it the lead (`setLead`), and write `rules`. `buildWakeInput` puts the rules in the trusted part of the agent's input ("Team rules, set by the team's owner. Follow them"). Their posts then wake that agent on its owner's runtime, the lead hears every post that names nobody, and the team's notes load into every run of the agent (`launch-context.ts` `teamsOfAgent`, "Team notes are shared by everyone on the team"). `isHome: true` moves the agent's home team away from the one its owner chose. The agent's owner cannot take it out again, because `removeMember` needs the team owner or an admin. SL-1 raised the root of this and SL.11 left it for a TM decision. | `teams.ts` `addMember`, `create`, `removeMember`; `inbox/wake-input.ts` | New task TM.19 (below) |
| 2 | must-fix | A lead's room run loses only its MCP write tools and its connectors. The runtime's own tools stay on: Pi's file and shell tools and `web_fetch` on cloud runs (`pi-run.ts`), Claude Code with `bypassPermissions` on machine runs (`apps/agentum/src/claude.rs`), and the `agent_toolset` on managed runs (`managed/gateway.ts`). The plan says the lead gets "team tools, read tools and send_message only", as "a tool restriction applied where the run's tool list is built, not a prompt line". The TM.4 review listed the gap under "Ideas beyond the scope", and no task covers it. A room run reads posts from every team member and, with SL, from a Slack channel. | `teams/room-run.ts`, `runs/launch-context.ts`, `pi-run.ts`, `runs/machine-claim.ts`, `managed/` | New task TM.20 (below) |
| 3 | must-fix | An archived team's room still works. `canPostInTopic` and `isInTeam` never look at `archived_at`, so a person posts in an old topic and every agent they mention wakes. `roomOf` still passes the archived team's rules into the wake. Only the lead is dropped. PROBE archived: after archiving, `@alpha go` started one run whose input held the team rules. `createThread`, `postNotice` and `leadRoomOf` already refuse an archived team, and the team page locks it, so the room is the gap. | `inbox/room-access.ts`, `inbox.ts` `post`, `roomOf`, `wake`, `deliver` | New task TM.21 (below) |
| 4 | must-fix | Private notes reach a room run. An agent in a person's `ui` or private conversation calls `inbox_post` to post in a team topic and mentions another agent. The woken agent's room run takes the posting run as its parent. `newSessionOwner` then makes its inbox session private and gives it to that person (`privateParentActor`), so `privateNotesUserOf` returns that person and their private notes load into the prompt. The reply is posted into the shared topic. Every agent that reply wakes inherits the private session too. PROBE private notes: beta's session was `{"origin":"inbox","private":true,"actor":"u1"}`, `loadPrivateNotesUser` returned `u1`, and beta's reply was in the topic. `private-notes.ts` says team rooms "get none even when one person started the run". | `runs.ts` `newSessionOwner`, `library/private-notes.ts` | New task TM.22 (below) |
| 5 | must-fix | A room lists only part of its topics. The room page and its loader call `inbox.listThreads`, which returns the workspace's 50 most recently posted topics across all teams (`THREAD_LIST_LIMIT`), and `topicsOfTeam` filters them in the browser. A team whose topics are not in that 50 shows an empty or partial room. A linked Slack channel opens a topic per top-level message, so busy rooms push quiet ones out quickly. TM.3 defines a room as the set of topics with one `team_id`. | `inbox.ts` `listThreads`, `components/room/room-page.tsx`, `routes/_app/teams.$teamId_.room.tsx` | New task TM.23 (below) |
| 6 | nit | Reading a team's room needs no membership. Anyone in the workspace can list and read every topic of every team that is not limited. The TM.3 review recorded this as a decision, and the plan only says posting needs membership. With SL a linked channel's messages become readable by the whole workspace. SL.11 limits private channels to admins. | `inbox/room-access.ts` `canReadTopic` | A decision for Dom: keep it, or make reading follow team membership outside Everyone |
| 7 | nit | `deliver` posts an agent's reply without `canPostInTopic`, so an agent removed from the team or the topic while its run is live still lands its reply (TM.3 nit, no task). | `inbox.ts` `deliver` | Check `canPostInTopic` in `deliver`, and drop the reply with an event when it fails |
| 8 | nit | The Slack card for a lead's proposal goes to the person the lead's run acts for, not to the member's owner, who is the only one who may answer it (TM.4 nit, no task). | `slack/requests.ts`, `teams/lead.ts` | Send the proposal card to the member's owner |
| 9 | nit | A lead can propose changes to itself. Its owner still approves, but the plan has the lead proposing changes to its members. | `teams/lead.ts` `memberAgent` | Refuse `agentId === run.agentId` |
| 10 | nit | A proposal that fails when applied (agent archived, model gone) is only logged, and the card reads "answered" (TM.4 nit, no task). | `teams/lead.ts` `events.onAppend` | Record a failed apply where the owner sees it |
| 11 | nit | An `instructions` proposal must fit in 7000 bytes with the reason (`PROPOSAL_INPUT_MAX_BYTES`), and it replaces the whole text. An agent whose instructions are longer than about 6.5 KB can never get one. An approval also overwrites any edit the owner made after the lead read the instructions. | `teams/proposal.ts`, `teams/lead.ts` | Store the proposal in its own row, and refuse the apply when the instructions changed since the proposal |
| 12 | nit | `addMember` with `memberKind: "user"` and `update` with `ownerUserId` accept any id string, with no check that the person is in the workspace. | `teams.ts` | Check the id against the workspace's members |
| 13 | nit | A limited topic's composer offers every team member, and the topic list does not mark a topic as limited (TM.7 nit). TM.13 fixes only the Assigned to line. | `components/room/mention-composer.tsx`, `topic-list.tsx` | Return the topic's members with the thread and use them in the composer |

## Must-fix tasks

### TM.19 An agent joins a team only with its owner's consent

Scope.

- `teams.addMember` with `memberKind: "agent"` needs the agent's owner (`effectiveOwner`) or an admin. So does `teams.create` with a `leadAgentId`. Use the owner check already in `requests.ts` (`requireAgentOwnerOrAdmin`).
- `isHome: true` for an agent is honoured only from its owner or an admin. For anyone else the flag is ignored and the first-home rule applies.
- `teams.removeMember` also lets the agent's owner remove their own agent from any team, archived or not.
- The default is the plain check above: a team owner who does not own an agent asks its owner to add it. Dom decides whether to add an invite instead, which would be a request in the agent owner's Needs you that adds the agent on approval. List this in the task file as an assumption.
- Leave existing memberships alone. The task file says how many cross-owner memberships staging and production hold, from a read-only query Dom runs.

Check.

- `teams.test.ts`: a team owner who does not own an agent cannot add it, make it lead at create, or move its home. The agent's owner and an admin can. The agent's owner can remove it from a team they do not own.
- A web test or the team page's component test shows the Forbidden message when a non-owner picks another owner's agent.
- `bun run check && bun run test && bun run build` pass.

### TM.20 A lead's room run gets no shell, file or web tools

Scope.

- `buildLaunchContext` already works out `inLeadRoom` from `leadRoomOf`. Expose it on `LaunchContext` as `teamRoom`.
- Cloud (`pi-run.ts`, `pi-run-gate.ts`): in a room run, install no file-writing, shell or `web_fetch` tool. Pi's read-only file tools may stay.
- Machine (`runs/machine-claim.ts`, `apps/agentum/src/claude.rs`): the claim carries `teamRoom`, and the client starts Claude Code with only read tools and the Agentum MCP server allowed (`--allowedTools` or `--disallowedTools`), keeping `bypassPermissions` otherwise. An older claim without the field behaves as today.
- Managed (`managed/gateway.ts`, `managed/service.ts`): a room run's session has the agent toolset off, or its write, bash and web tools disabled in its configs.
- In its own conversations the lead keeps every tool, as TM.4 says.

Check.

- Per runtime, a test that a lead's room run has no write, shell or web tool and the same agent's `ui` run has them. `cargo test` for the client flag.
- `bun run check && bun run test && bun run build` pass, including the agentum-rs tests.

### TM.21 An archived team's room is read-only

Scope.

- Posting in a topic of an archived team is refused for people and runs (`requireThread` with `"post"`, through `canPostInTopic` or a check beside it). `clearAttention` may still work.
- `wake` starts no run in an archived team's topic, so a reply that was already running lands, and wakes nobody. `roomOf` gives no rules for an archived team.
- `postExternal` refuses an archived team too, in case a caller other than `findRoomLink` reaches it.
- The room page shows an archived team's topics without the composer or New topic, with one line saying the team is archived.

Check.

- `inbox.test.ts`: after archiving, a person's post is refused, an agent's reply from a run started before the archive lands and wakes nobody, and a mention starts no run.
- A component test for the archived room.
- `bun run check && bun run test && bun run build` pass.

### TM.22 A room run never gets private notes

Scope.

- In `runs.ts` `newSessionOwner`, a new session whose origin is shared (`inbox` at least; check `qa` and the Slack origins too) never inherits privacy from a private or `ui` parent run. It belongs to the run's actor and is not private.
- Also make `privateNotesUserOf` return null for origin `inbox`, whatever the session's `private` flag says, so a session already stored as private gets no notes either. Update the module comment.
- A read-only query Dom runs counts inbox sessions with `private = 1` on staging and production. The task file records the count and what to do with them.

Check.

- `inbox.test.ts`: the probe case. A run in u1's `ui` session posts `@beta` into a team topic, and beta's session is not private and `loadPrivateNotesUser` returns null. A second hop from beta's reply gets none either.
- The existing private-notes tests still pass.
- `bun run check && bun run test && bun run build` pass.

### TM.23 A room lists all of its own topics

Scope.

- `inbox.listThreads` takes an optional `teamId` and filters by it in SQL, before the limit. Without it, it behaves as today for the desk.
- The room page and the room route's loader pass the team's id. `topicsOfTeam` stays only as a guard, or goes.
- The lead's `inbox_list` tool, if it lists topics, passes the run's room team when called from a room run.

Check.

- `inbox.test.ts`: with 60 recent topics in team A and one older topic in team B, listing team B returns its topic.
- `inbox-router.test.ts` covers the new input.
- Browser at desktop size: a team whose only topic is older than 50 others shows it in its room.
- `bun run check && bun run test && bun run build` pass.

## Steps for Dom

- Decide finding 1's default: owner-or-admin only, or an invite the agent's owner approves.
- Decide finding 6: whether reading a team's room should need membership.
- TM.19 and TM.22 each ask for one read-only count on staging and production D1.

## Controller decisions (2026-11-21)

- Must-fix 1 to 5 became TM.19 to TM.23.
- Finding 1: owner-or-admin only, no invite flow. Dom can ask for an invite later.
- Finding 6: reading a team's room stays open to the whole workspace, as the TM.3 review decided. Posting needs membership. Dom can reverse this.
- The read-only D1 counts for TM.19 and TM.22 are run by the controller, not Dom.
