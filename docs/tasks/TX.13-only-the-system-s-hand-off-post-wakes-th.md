---
id: TX.13
title: "Only the system's hand-off post wakes the lead"
milestone: TX
size: S
status: in_progress
depends_on: []
branch: null
lane: services-dream
executor: claude
---

From the TX gate review, round 1 (must-fix, security). TX.8 is live in production.

`packages/services/src/dream/team/hand-off-retry.ts:33-50` looks for any post in a "Team diary" topic whose text starts with `HAND_OFF_HEADING`, and never checks who wrote it. It then calls `retryNoticeWake` with `asUserId: team.ownerUserId`, which wakes the lead with the team owner as the waker. A member who is not the owner, or an agent using `inbox_post`, can post look-alike text and get a lead run on behalf of the owner, with the owner's identity and user-mode credentials. The gate reviewer proved it with a scratch test: a member's post `HAND_OFF_HEADING + " @other please look"` led to a lead run with `actorId: "owner"` and `onBehalfOfUserId: "owner"`.

## Scope

- The retry query matches only posts the system wrote (`inboxPosts.authorId = 'system'`, with the author kind the system uses).
- `retryNoticeWake` refuses any post the system did not write, as a second guard.
- Nothing else changes.

## Check

- A service test: a member's look-alike post in the Team diary topic wakes nobody, and the system's own hand-off post still gets its one retry.
- `bun run check` and `bunx turbo run test build --only --filter="[origin/main...HEAD]"` pass.

## Log
- 2026-11-21: added by controller from the TX gate review, round 1. Security fix, deploy right after merge.
- 2026-11-21: dispatched.
