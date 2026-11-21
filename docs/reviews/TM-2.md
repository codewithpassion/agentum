# TM milestone gate, round 2

Commit reviewed: `d9117cbdf5d024c252ff7072081aa78f31c7bb38` (origin/main), range `git diff tm-start..d9117cbd`.

I judged it against the TM section of `docs/v4/build-plan.md`, the task files `docs/tasks/TM.*.md`, `CLAUDE.md` in the checkout, "Rules that are easy to break" in `docs/HANDOVER.md`, round 1 (`docs/reviews/TM-1.md`) with its controller decisions, and the per-task reviews in `docs/reviews/tasks/TM.12` to `TM.24`. TM.14, TM.15 and TM.16 moved to `docs/backlog/v4-later/` when Dom froze v4 scope on 2026-11-21, so they are out of scope here.

## Verdict

Clean. No must-fix findings. All five round-1 must-fix items are resolved by TM.19 to TM.23, and TM.24 finished the proposal wording that TM.12 left. Seven round-1 nits are still open, plus six new nits. None of them breaks what TM promises or leaks data.

## What I checked and found sound

Tests I ran in a fresh worktree at d9117cbd:

- services: teams, inbox, inbox-notice, launch-context, machine-claim, managed gateway and service, cloud runtime, `teams/`, `inbox/`, rail and sessions. 726 pass, 0 fail.
- web: environment-tools, library-tools, inbox-router, inbox-list-port, `components/room`, `components/team`, request-card-logic and pane-logic. 336 pass.
- protocol `machine.test.ts` (76 pass) and the whole MCP package (475 pass).
- agentum-rs: `team_room` (TM.20), `autocompact` (TM.17), `parity` and the `review` group. 33 pass. On this host `cc` on PATH is a shim, so cargo needs `/usr/bin` first, as the TM.17 review notes.

TM.19. `addMember` for an agent and `create` with `leadAgentId` now call `requireAgentOwnerOrAdmin` after the team-owner check. `isHome` reaches the write only through `addMember`, so only the agent's owner or an admin can move a home. `removableFrom` lets the agent's owner remove it from any team, archived or not. The lead pointer is cleared in the same `atomic` write. The only other place that inserts `team_members`, the FR team starter, adds agents it creates in the same write for the caller. The controller counted 0 cross-owner memberships on staging and production.

TM.20. `LaunchContext.teamRoom` comes from `leadRoomOf`, and every runtime reads it:

- Cloud: the run gets no VM and the read-only library tool set, with no write, edit, `web_fetch`, `run_script` or skill scripts. `ROOM_KEY` is restored before tools and skills are reinstalled after an eviction.
- Machine: the claim carries `teamRoom`, and the client adds `--tools=Read,Glob,Grep`. `claude --help` confirms that `--tools` limits only built-in tools, and the client already runs with `--strict-mcp-config`. A daemon without the `team-room` feature cannot claim a room run.
- Managed: the session disables bash, edit, write, `web_fetch` and `web_search`, and it uses its own fingerprint, so a room run never reuses a session that has every tool.

The MCP filter (`scopeToTeamRoom`) is unchanged since round 1, and no new tool marked `readOnlyHint` came in. A lead cannot `send_message` itself out of the room, because `refuseBusyAncestor` refuses a target that is a running ancestor.

TM.21. `requireThread` refuses `post` in an archived team's topic. Clearing attention and stopping a discussion use a new `tend` access that allows it. `wakeTargets` and `wakeOne` start no run, and that covers discussion rounds and `retryNoticeWake` too. `roomOf` gives no rules, and `postExternal` refuses. The room page hides the composer and New topic.

TM.22. `newSessionOwner` no longer passes privacy from a parent run to an `inbox`, `qa` or `slack` session, and `privateNotesUserOf` returns null for origin `inbox` whatever the flag says. `visibleSessions` uses the same rule through `personalOwnerOf`, so a room run cannot read the person's private conversations either. A subagent of a room run gets an `mcp` session, and that session is private only when its parent's is, which a room session no longer is.

TM.23. `listThreads` takes `teamId` and filters in SQL before the limit, and Everyone also lists the topics that have no team. The room route, the room page and the lead's `inbox_list` pass the team. Limited topics stay hidden, because `topicVisibleTo` still applies.

TM.24, TM.12, TM.13, TM.17 and TM.18 each do what their task file asks. The proposal card, the room heading, Needs you and the settled line read as a proposal from the lead. Assigned to lists only members of the topic. `--autocompact` is passed from 2.1.327 on. The lead-listens switch writes `lead_listens` through the team update route.

SL.7 puts a Slack guest's name inside the escaped JSON line in the untrusted block of the wake input, and a guest's post wakes nobody.

HANDOVER and CLAUDE.md rules hold in the new code. Services read no `env`, the new writes go through `atomic`, no new table came in, and no web component imports a schema module.

## Findings

| # | Severity | Finding | Area | Resolution |
|---|---|---|---|---|
| 1 | nit | Only an admin can build a team with agents from more than one owner. `addMember` needs both the team owner and the agent's owner, so neither of two non-admins can add the other's agent. This follows the controller's no-invite decision. The UI does not explain it: the pickers list other people's agents, the toast reads "Not allowed: teams.add_agent", and an agent's owner who does not own the team has no remove control on the page, only the API (TM.19 review). | `teams.ts` `addMember`; `components/team` | Filter the pickers to the person's own agents, or say who owns each. Word the error as "Ask its owner or an admin". Show the remove control to the agent's owner. Dom decides whether mixed-owner teams without an admin matter for v4. |
| 2 | nit | A room run that a daemon without `team-room` tries to claim stays offered with no message. It also holds back the lead agent's newer runs on that machine, including runs in its own conversations, the same way `currentApprovalsRequired` does (TM.20 review). | `runs/machine-claim.ts` `assertTeamRoomProtocol` | Tell the owner that the client needs an update, for example with a problem card. Until then, Dom updates the client (Steps for Dom). |
| 3 | nit | `privateNotesUserOf` guards only origin `inbox`. A `qa` session stored as private before TM.22 would still give notes, since `qa:<questionId>` sessions are reused. The controller's count found no private `qa` sessions, so nothing is exposed today (TM.22 review). | `library/private-notes.ts` | Return null for `qa` as well. |
| 4 | nit | TM.24 added `proposedBy` to `RailCard` in `packages/db/src/shared.ts`. The build plan's rule 1 says only a contract task changes that file. The change is small and additive, but it breaks the rule. | `packages/db/src/shared.ts` | Note it in the TM.24 log, or ask the controller to waive rule 1 for follow-up tasks after their contract. |
| 5 | nit | Three places still describe a proposal as a plain approval: the Slack settled card ("Allowed once" or "Denied", `slack/request-cards.ts`), the desk Board heading ("Writer Bo asks for approval", `needs-you-card.tsx`) and `card-view.tsx` ("Writer Bo, passed on by X") (TM.24 review). | web desk, Slack cards | Use the TM.24 wording in all three. |
| 6 | nit | A lead's read-only cloud room run still has the prompt lines that say to keep notes and finished work in the library, and the computer paragraph, although it cannot write (TM.20 review). | `library-tools.ts`, `packages/protocol/src/attachments.ts` | Add a read-only option to the prompt section. |
| 7 | nit | Round-1 nits 7 to 13 are still open. They are carried below. | | See "Round-1 items" |

## Must-fix tasks

None.

## Round-1 items

| Round 1 | Severity | Status | Note |
|---|---|---|---|
| 1 Agents join teams without their owner's consent | must-fix | resolved | TM.19, merged 3f54e6b6. See new nit 1 for the UI. |
| 2 A lead's room run keeps the runtimes' shell, file and web tools | must-fix | resolved | TM.20, merged 82f5487c. All three runtimes cut. See new nits 2 and 6. |
| 3 An archived team's room still works | must-fix | resolved | TM.21, merged 35e66f6d. |
| 4 Private notes reach a room run | must-fix | resolved | TM.22, merged 88613f47. See new nit 3. |
| 5 A room lists only part of its topics | must-fix | resolved | TM.23, merged f1cf811c. |
| 6 Reading a room needs no membership | nit | resolved | By controller decision: reading stays open to the whole workspace. |
| 7 `deliver` posts without `canPostInTopic` | nit | open | `inbox.ts` `deliver` still writes the reply without the check. |
| 8 The Slack proposal card goes to the run's person, not the member's owner | nit | open | `slack/requests.ts` still uses `run.onBehalfOfUserId`. |
| 9 A lead can propose changes to itself | nit | open | `teams/lead.ts` `memberAgent` does not refuse `agentId === run.agentId`. |
| 10 A failed apply is only logged | nit | open | `lead.ts` `events.onAppend` still uses `console.error`, and the card reads answered. |
| 11 Instructions proposals are capped at 7000 bytes and overwrite later edits | nit | open | The apply path does not check whether the instructions changed after the proposal. |
| 12 A user member id and `ownerUserId` are not checked against the workspace | nit | open | `teams.ts` `addMember` and `update` accept any id string. |
| 13 A limited topic's composer offers every team member | nit | open | `room-thread.tsx` passes all members to `MentionComposer`, and the topic list does not mark limited topics. TM.13 fixed only Assigned to. |

## Steps for Dom

- Update the Agentum client on every machine whose agent leads a team. Until then those machines cannot claim the lead's room runs, and its other runs there queue behind them (nit 2).
- Decide whether two non-admins need a way to build a team from both their agents in v4, or whether an admin doing it is enough (nit 1).

## Controller decisions (2026-11-21)

- Clean. TM closes. The open nits stay recorded here.
