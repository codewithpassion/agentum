# TM.7 review: team room UI, topics and posts

Built with Haiku workers for five disjoint units (mention logic, room logic, post and avatar, topic list and new-topic dialog, mention composer). The dispatcher wrote the route, the page, the thread panel and the inline requests block, and made the review fixes. Reviewed by Opus. Browser proof by a fresh Opus verifier, report and screenshots in `docs/reviews/tasks/TM.7/` (`browser.md`).

## Rounds

- Round 1, at ea8bdd01: not clean. Two must-fix: the phone topics sheet and the New topic dialog could not scroll.
- Round 2, at 0c818b57 (fix only): clean.
- Browser proof round 1 failed on the inline approval: the seed put the approval on a run that had already posted, and the settled line was hidden at once. The seed script now adds a waiting run, as a real task that asks before it replies. The card logic changed too, so an answered card stays until a newer post lands.
- Review at 5be6ce29 (that fix): not clean. The post count stops growing at the 500-post read cap, so an answered card would never leave a long topic. Fixed by comparing the newest post id.
- Browser proof round 2 failed on reload and remount losing the settled line. Judged not a defect: the line is a local confirmation and the server keeps no answered request in the pending list. The flow text was clarified for round 3.
- Review at 92e23647: not clean. The sticky topics column slid under the sticky top bar. The sticky classes were reverted rather than patched.
- Review at f3eb3db0 (revert and heading tweak): clean.
- Browser proof round 3, at 92e23647: pass, flows A to I at 1280x800 and 390x844. Since then only one className (the sticky aside, reverted to the form the first two rounds saw) and the "needs you" heading on answered cards changed.

## Decisions the task left open

- Route file `teams.$teamId_.room.tsx`. The trailing underscore keeps the room out of a `teams.$teamId` layout, so TM.6's team page cannot swallow it. The path is still `/teams/$teamId/room`.
- Topics are filtered by `teamId` in the browser, because `inbox.listThreads` has no team filter. Legacy null-team topics show in the Everyone room only.
- Everyone has no member rows, so its room offers every active agent and every workspace person. A person can post in Everyone and in any team they belong to. In another team they can read open topics and see no composer and no New topic button.
- Agents in the mention list come from `roster.list` (it carries the avatar), people from `members.list`, and a person's handle from `teams.profiles.get`. A person with no handle is not offered. The signed-in person is left out of their own mention list and of the New topic member list (the server always adds the creator).
- Requests inline: the topic's inbox sessions are found with `sessions.list({ origin: "inbox" })` (`externalKey` is the topic id) and matched to `requests.pending`, because a run that waits has not posted yet. The card is the existing `RequestCard`. An answered card stays as a local confirmation until a newer post lands or the topic is left.
- The mention pattern is a local copy of the server's, because `inbox/mentions` is not exported from `@repo/services`.
- "Assigned to" shows for a post by the team's lead agent that mentions members, minus the lead itself.

## Nits left

- A limited topic's composer offers every team member, not only the topic's members, and nothing in the topic list marks a topic as limited. `ThreadRecord` carries no member list.
- `sessions.list` is capped at 50 sessions, so in a very busy workspace a topic's pending request can be missed. `requests.pending` already takes `sessionId`, so a topic-to-session lookup on the server would let the page do one query.
- `?topic=` is not checked against this team's topics. A visible topic of another team renders with this room's composer state. The server still enforces access.
- Posts name a person from `members.list` (the Clerk name), not from the room profile name.
- The mention list opens upward over the latest post. The Dismiss button has no explanation.
- Mention rows and the member checkboxes are under 44 px tall on a phone (the checkbox is shadcn output).
- Safari sends the Enter that ends an IME composition with `isComposing` false, so it can pick a mention. Adding `keyCode === 229` to the guard would cover it. No test covers blur-close, Shift+Enter or the IME guard.
- The loader reads one profile per person on every navigation inside the room.
- Nothing links to the room, and TM.6 merged without a link. The team page (or the Teams list) needs a "Room" link to `/teams/$teamId/room`, in `components/team/`, outside this task's lane. Until then, open it by URL.

## Ideas beyond the scope

- A `teamId` filter on `inbox.listThreads`, so a quiet team's older topics do not fall out of the 50-topic cut.
- Show an `inbox.loop_stopped` note in the room, so an agent that is out of wakes (10 an hour) does not look hung.
- A per-person dismissal and a topic-to-sessions read on the server.

## Steps for Dom

None. No migration, secret or dashboard change.
