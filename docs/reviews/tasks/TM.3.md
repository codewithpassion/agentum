# TM.3 review: team room, topics, catch-up, team rules, lead listening

Dispatched with Haiku workers for three disjoint units (`inbox/wake-input.ts`, `inbox/room-access.ts`, `inbox/post-links.ts`). The dispatcher wired them into `inbox.ts`, wrote the service tests and fixed the review. Reviewed by Opus.

## Rounds

- Round 1, at f1fc6482: borderline must-fix. `clearAttention` needed only read access, so a person outside a team could dismiss a team room's Needs you card for everyone. Fixed as a must-fix.
- Round 2, at ca7cc778 (fix only): clean. `clearAttention` needs post access. The desk lists a team room's replies in Needs you only for the team's members.

## Decisions the task left open

- Reading a team room needs no membership. Posting needs team membership. The Everyone team and a topic with no team are open to every workspace person and agent, because Everyone has no member rows.
- A topic with `inbox_thread_members` rows is readable and postable only by those members, and posting still needs team membership. A hidden topic answers `not_found` on read, post and dismiss. `listThreads` filters it in SQL before the limit.
- The inbox session of a limited topic (`sessions.external_key` is the thread id) is hidden from non-members in `visibleSessions`, so its runs and wake inputs stay with the members.
- A mentioned agent that cannot post in the topic is not woken. An `inbox.loop_stopped` event with reason `refused` records it. The lead is skipped without a record.
- Catch-up is per woken agent: every post since it last posted in the topic, read newest first with a bound of 200 rows, then the 8000-character budget drops the oldest. A trusted note tells the agent when posts were dropped. The old count cap of 10 is gone, so two old tests were rewritten on purpose (the 10-post test and the "own earlier reply is quoted" test).
- Team rules go after the instruction block and before the optional digest and the untrusted block. Any `<` that starts an `untrusted-thread-posts` tag in the rules becomes `<`. The block, its markers and the post escaping are unchanged.
- The digest slot is an optional `digest` argument of `buildWakeInput`. Nothing fills it yet (TX.2).
- Lead listening: a person's post that resolves to no active agent wakes the team's lead when `lead_listens` is on, the team is live, the lead is active and the lead may post in the topic. An agent's post never does.
- The loop guard is unchanged. The streak counts per topic and the wake budget stays per agent (10 an hour).
- `createThread` takes optional `teamId` (the creator must be in the team) and `members` (the creator is added; each must be in the team and agents must exist in the workspace). It writes through `atomic`.
- A post carries `runId`, `fileIds` and `artifacts`. For a run the reader cannot see, `runId` is null and the files and artifacts are empty. Visibility is `visibleSessions` on the run's session, as a subquery with no bound id lists. Artifacts follow the artifact audience rule (`canOpen`, `agentCanSee`).
- The desk's `inbox_reply` card keeps its `runId` only for a member who can see that run.

## Nits left

- `deliver` posts an agent's reply without checking `canPostInTopic`, so an agent removed from the team or topic while its run is live still lands its reply.
- `isInTeam` ignores `teams.archived_at`, so members can still post in an archived team's existing topics. New topics in it are refused.
- `limitedMembers` accepts any user id for an Everyone or no-team topic, because user ids are not checked against the organisation (the same gap as TM.2). It accepts archived and draft agents as topic members.
- A person's post that names only unknown or inactive slugs counts as naming no agent, so the lead wakes. No test covers it.
- The lead gets `canPostInTopic` twice on a wake (in `listeningLead` and in the wake loop).
- The desk repeats the `isInTeam` rule in SQL. A shared helper in `room-access.ts` would keep them in step. No desk test uses the Everyone team.
- The marker regex allows only `\s` between `<` and the tag name. Rules sit above the open marker, so this is defence in depth.
- The thread panel (`components/inbox/thread-panel.tsx`) shows Dismiss and the composer to a non-member, and both now fail with Forbidden. TM.7 and TM.9 replace that page.
- `inbox.posted` and `inbox.loop_stopped` events carry no session, so the event feed still shows a limited topic's thread and post ids to everyone. No text leaks.

## Ideas beyond the scope

- A per-topic wake budget (agent and topic) if a busy lead in several rooms hits the 10 an hour limit. The task says the guard is unchanged, so this was left alone.
- `listThreads` takes an optional `teamId` filter, so the room UI lists one team's topics without the 50-thread cut across the workspace.
- Dismissal is one stamp on the thread for everyone, not per person. A per-person dismissal would fit rooms better.

## Steps for Dom

None. No migration, secret or dashboard change.
