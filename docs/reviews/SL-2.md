# SL milestone gate, round 2

Commit reviewed: `d9117cbdf5d024c252ff7072081aa78f31c7bb38` (origin/main on 2026-11-21). Range: `git diff sl-start..d9117cbd`.

The range has 2302 changed files from every v4 milestone. Round 1 stopped at 2ba09899, and 272 commits landed after it. I read the SL commits among them, with their merges:

- SL.10: 93cf899b, merged c4952195
- SL.11: d3382608 and 196f3ddd, merged 9357ef6f
- SL.12: 02e26ace and 905b6a4b, merged d895ba73
- SL.13: a1a5af68 and 51cc0713, merged fe272f76
- SL.6: 56cae3e8, merged cfb162b2
- SL.7: 72c0776c and b1ad8321, merged 97758fa5
- SL.8: be4dbb39 and 4a77f437, merged c8931614

I also read the Slack files as they stand at d9117cbd. `git log 2ba09899..HEAD` over `packages/services/src/slack`, `slack.ts` and `routes/slack.ts` shows one non-SL commit, TX.6 (cfb8d31c). It gives the decision queue a Slack card, so a decision card in a room run now goes to the room's Slack thread. It uses the same access check as every other card. That belongs to the TX gate.

I judged the range against the SL section of `docs/v4/build-plan.md`, `docs/tasks/SL.*.md`, `CLAUDE.md` in the checkout, "Rules that are easy to break" in `docs/HANDOVER.md`, `docs/reviews/SL-1.md` with its controller decisions, and the per-task reviews in `docs/reviews/tasks/SL.6` to `SL.13`. SL.9 sits in `docs/backlog/v4-later/` and is out of scope, as the scope freeze says.

Tests I ran at d9117cbd, all passing:

- `packages/services`: `src/slack/`, `slack-history`, `teams`, `requests`, `runs/fake-runtime` and `inbox` tests. 679 pass across 29 files.
- `apps/web`: `slack-room-flow.test.ts`, `routes/slack-events.test.ts`, `components/team/slack-section.test.tsx` and `components/room/`. 199 pass across 11 files.
- `packages/db`: `guest-name-migration.test.ts`. 1 pass.

I wrote no probe this round. The one must-fix below comes from reading the code.

## Verdict

Not clean. One must-fix.

The four round-1 must-fixes are resolved. SL.6, SL.7 and SL.8 do what their tasks ask. The one new must-fix undoes part of SL.13. SL.13 refuses to link a Slack Connect user by email inside a linked channel, because another organisation controls that user's email. The older per-agent path still links that user by email after one mention or DM anywhere else. The room then trusts the link and posts as the matched Agentum person. `SL-e2e.md` step 7 now says such a person "is never linked by email and stays a guest", and that is not true.

## What I checked and found sound

**SL.10.** `room.receive` drops a copy unless `memberSenderApps` lists the delivering app for the linked team. `memberSenderApps` joins `team_members` to active agents with installed apps. The check drops the copy before any write, and it returns `accepted`, not null, so the copy never reaches the per-agent path. The flow test signs an event with an outsider app's secret and finds no post, no topic, no `slack_room_messages` row, no `slack_messages` row and no run. The module header records the accepted assumption, as the controller decided.

**SL.11.** For a non-admin, `teams.slack.channels` lists only public channels that the bot and the person are both in. An admin sees all. `teams.slack.link` refuses a non-admin who has no Slack link, who is not in the channel, or who picked a private channel. Each refusal tells the person what to do. `canPost` still requires a team app in the channel. `linkSlack` is the only writer of `team_slack_links`. The team page shows the private-channel note. `topicRootTs` now takes the current Slack team and channel, and both callers (`room-out.ts` and `slack/requests.ts`) pass them. A flow test covers the relink. Real Slack's `users.conversations?user=` with a bot token returns public channels that user is in whether or not the bot is in them. The service intersects that list with the bot's channels for the listing, and `canPost` covers linking, so the gap between the fake and real Slack does no harm.

**SL.12.** `requests.answer` runs `requireAlwaysAllowRight` before the request closes. The only other writes that close a `run_requests` row are `answerDecisions` (decision queues, no always allow) and the a2a peer answer (a peer's text for a guest run). The other `status: "answered"` writes in `dream.ts`, `dream/team/answer.ts`, `dream/undo.ts` and `qa.ts` go to `dream_questions` and `qa_questions`. None of them stores `always_allow`. The desk API goes through `answer`. The mail release calls the unchecked `recordAlwaysAllow` only after `answer` has accepted the decision. The Slack path catches the error by its reason code, sends the ephemeral reply and leaves the card open. The flow test proves that no rule is written and the request stays pending. `CLAUDE.md` now states the exception.

**SL.13.** In a linked channel, `author` matches an unlinked Slack user by email with `ownTeamOnly: true`, posts as that person when they are in the team, and tells a guest once. The "told" event rides in the winning post's write. The team check runs before the email check, so a Slack Connect user with a hidden email gets no reply. The route tests listed in the task's Check exist and pass: tests at lines 1774, 1806, 1836, 1847, 1863 and 1887 of `slack-events.test.ts`. The flow test's "Slack to room" case deletes the seeded links and links Dom by email. `SL-e2e.md` "Before you start", step 3 and step 7 were updated.

**SL.6.** The fake runtime opens one approval per run, with the stable `toolUseId` `fake-ask-<runId>`, when the text holds `ask:<tool>`. `resume` ends the run with the decision. The mode exists only when `devFakeRuntime` registers the fake adapter. `compose.ts` wires `askApproval` in every build, and it is never called in production.

**SL.7.** Migration 0061 adds `inbox_posts.guest_name` and splits the old prefix. The migration test covers a guest, a bare `slack:` post, a member quoting the phrase and an agent post. The room, `slack_search`, the wake context, the MCP ports and the team dream read the column. Migration numbers have no duplicates, and the journal ends at 0061. SL.7 changed the schema outside the `contract` lane. Its task text asked for a contract task. SL.6 likewise edited `apps/web/src/server/compose.ts` outside the contract lane. No collision followed in either case, so I do not count them as defects.

**Repo rules.** The SL changes keep services as factories built in `composeWith`, keep `workspace_id NOT NULL` on the one new column's table, add no barrel files and no new bindings. `CLAUDE.md` gained the Always-allow exception that SL.12 introduced, and it matches the code.

**SL.8.** Inbound, `readSlackMarkup` turns user, channel, broadcast and link tokens into text and decodes entities, including inside tokens. Agent mentions become `@slug` before that step, so waking still works. Outbound, `toSlackMrkdwn` escapes `&`, `<` and `>` before it adds any markup, and the client skips its own escaping only when `mrkdwn: true`. The only markup added after escaping is a `<@U...>` mention for one linked person. `convertMentions` leaves `@here`, `@channel` and `@everyone` as plain text, so a typed broadcast pings nobody. A guest post is never sent out.

**Signing and replay.** Nothing changed in `routes/slack.ts` or in the `receive` signature path since round 1. Round 1's finding still holds.

## Findings

| # | Severity | Finding | Area | Resolution |
|---|---|---|---|---|
| 1 | must-fix | A Slack Connect user can still be linked by email and then post in a linked channel as an Agentum person. `meetUnlinkedSender` calls `matchByEmail` with `ownTeamOnly: false`. A Slack Connect user who mentions any agent's app in an unlinked shared channel, or DMs it, gets an `identity_links` row with the same key (`workspace_id`, `slack`, the app's Slack team, Slack user id) that `findLink` reads. After that, `room.author` takes the link and never runs the own-team check, so the user's posts in the linked channel count as the matched person and wake the lead on their behalf. SL.13 promised the opposite, and `SL-e2e.md` step 7 says so. The premise is the same one SL.13 rests on: the other organisation controls that user's email. Whether real Slack shows an external user's email to the bot is unverified. No test covers the per-agent path with another team's user, and no decision accepts it. `docs/reviews/tasks/SL.13.md` lists it under "Ideas beyond the scope", so it was known and left undecided. | `slack.ts` `meetUnlinkedSender`, `slack/room.ts` `accountOf` | New task SL.14 (below) |
| 2 | nit | The staging walkthrough runs out of order for a non-admin. Since SL.11, step 1 (Link channel) needs the walker to be an admin or already linked to Slack, but "Before you start" says no link needs to exist, and the link only appears at step 3. The doc does not say whether the `agent-login` user is an admin. The walkthrough also has no step for SL.10, SL.11 or SL.12 (an outsider app, a non-admin linking, a non-owner pressing Always allow). | `docs/reviews/SL-e2e.md` | Say the walker must be an org admin for step 1, or link first by mentioning A outside the channel. Add the three checks to the end-of-v4 browser pass. |
| 3 | nit | A topic a guest opens still stores the guest id (`slack:<team>:<user>`) in `inbox_threads.created_by`. SL.7's own finding named this, and the SL.7 review lists it as left. | `inbox.ts` `postExternal` | Fold into a later SL or TM cleanup |
| 4 | nit | `wasTold` matches `slack.unlinked_sender` events on Slack user id within the workspace, not on Slack team and user id. A Slack user id is unique only within its Slack team. The per-agent `admitUnlinked` writes the same event type, so a person told once in a DM is never told in a room. The told event is also written with the post, even when the ephemeral reply then fails, and that person is then never told. | `slack/room.ts` | Match on the Slack team too. Accept the rest. |
| 5 | nit | Every copy of every message from an unmatched guest calls Slack `users.info` and the Clerk directory, one call per member app. Nothing remembers a no-match. Real Slack rate-limits `users.info`. | `slack/room.ts` `accountOf` | Remember a no-match per Slack user for a while |
| 6 | nit | `users.conversations` reads at most five pages. A non-admin who is in more public channels than that may be told they are not in a channel they are in. | `slack/client.ts` `listChannels` | Raise the cap for the person query, or check one channel with `conversations.members` |
| 7 | nit | Markdown links become Slack masked links, so an agent's post can show one URL and open another (`[bank.com](https://evil.example)`). The SL.8 review raised this and nobody decided it. | `slack/room-out-text.ts` | Dom decision. Showing the URL when the label looks like a host would close it. |
| 8 | nit | Several identity links can exist for one Agentum user in one Slack team, for example a real one and one from finding 1. `slackUserOf` takes whichever comes first with `limit(1)`, so the SL.11 channel check can run against the wrong Slack account. | `teams.ts` `slackUserOf` | Gets smaller once SL.14 lands. Order by `created_at` or refuse when there are two. |

## Must-fix tasks

### SL.14 The per-agent path links only its own Slack team's users

Scope.

- In `slack.ts` `meetUnlinkedSender`, call `matchByEmail` with `ownTeamOnly: true`, as the room path does. A user of another Slack team (Slack Connect) is not linked. They get the same reply the room gives such a user: none. Leave the `slack.unlinked_sender` event in place.
- Leave existing `identity_links` rows alone. Write in the task file that a link written earlier for an outside user stays until someone deletes it, and that Dom can ask for a one-off cleanup. Such links exist only if an outside user mentioned an app before this fix.
- Two side effects, listed as assumptions Dom can change. A failed `users.info` call on the per-agent path now gets silence instead of the hidden-email reply. An Enterprise Grid member of a sibling workspace, whose `team_id` differs from the app's, can no longer be linked at all, because the email match is the only way to link.
- Correct the comment on `matchByEmail` that describes `ownTeamOnly` as optional behaviour, so it says both paths use it.

Check.

- `slack-events.test.ts`: a user whose `users.info` `team_id` is another Slack team, with an email that matches an org member, mentions a member app in an unlinked channel. No `identity_links` row appears and no run starts. The same user then posts in the linked channel. The post is a guest post and wakes nobody.
- The existing DM and mention tests for users of the app's own Slack team still link them by email.
- `bun run check && bun run test && bun run build` pass.

## Round-1 items

| Round-1 item | Status | Notes |
|---|---|---|
| Must-fix 1: any installed app feeds the room | resolved | SL.10. The member-owner assumption is accepted by the controller. |
| Must-fix 2: any member links any channel | resolved | SL.11. Private channels are admin-only, by the controller's decision. `teams.addMember` consent stays with TM, as decided. |
| Must-fix 3: Always allow skips the owner check | resolved | SL.12. `answer` is the only closer that stores `always_allow`. |
| Must-fix 4: no linking inside a linked channel | resolved | SL.13 does what its task says. Finding 1 above is a gap through the per-agent path, tracked as SL.14. |
| Nit 5: `topicRootTs` ignores the channel | resolved | Folded into SL.11, with a relink flow test. |
| Nit 6: room card has no fallback to DM | open | `roomDestination` still tries only the requester's app. A failure still goes to the owner as a problem item. |
| Nit 7: card shows tool input to the channel | resolved | Accepted by controller decision. Dom can reverse it. |
| Nit 8: flow test card run uses a `ui` session | open | `openRoomApproval` still starts the run with `origin: "ui"`. The SL.12 case covers a non-owner pressing Always allow, but not who else may press the other buttons. |
| Nit 9: `teams.slack.status` makes per-app Slack calls on every room view | open | `room-status.ts` has not changed since round 1. |
| Nit 10: identity link trusted with no fresh org check | open | `findLink` still reads the link alone. `isOrgMember` runs only when a link is created. |
| Nit 11: `searchRoomMessages` includes archived teams | open | `room-search.ts` still has no `archivedAt` filter. |

## Controller decisions (2026-11-21)

- Must-fix 1 becomes SL.15, because SL.14 was already taken by the browser-pass fix. The two side effects the review lists are accepted: a failed `users.info` call on the per-agent path gets silence, and an Enterprise Grid member of a sibling workspace can't be linked by email.
- This is the second gate round, so SL closes when SL.14 and SL.15 are done. Open nits stay recorded here.
