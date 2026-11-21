---
id: TM.21
title: "An archived team's room is read-only"
milestone: TM
size: S
status: ready
depends_on: []
branch: task/TM.21-an-archived-team-s-room-is-read-only
lane: services-inbox
executor: claude
---

From the TM gate review, round 1 (`docs/reviews/TM-1.md`, must-fix 3).

## Scope

- Posting in a topic of an archived team is refused for people and runs (`requireThread` with `"post"`, through `canPostInTopic` or a check beside it). `clearAttention` may still work.
- `wake` starts no run in an archived team's topic, so a reply that was already running lands, and wakes nobody. `roomOf` gives no rules for an archived team.
- `postExternal` refuses an archived team too, in case a caller other than `findRoomLink` reaches it.
- The room page shows an archived team's topics without the composer or New topic, with one line saying the team is archived.

## Check

- `inbox.test.ts`: after archiving, a person's post is refused, an agent's reply from a run started before the archive lands and wakes nobody, and a mention starts no run.
- A component test for the archived room.
- `bun run check && bun run test && bun run build` pass.
## Log
- 2026-11-21: added by controller.
- 2026-11-21: dispatched.
- 2026-11-21: dispatcher stopped at the account monthly spend limit (HTTP 429). Work is saved in its worktree. Resume the same dispatcher after the limit resets on Nov 25.
- 2026-11-21: spend limit reset, same dispatcher resumed.
- 2026-11-21: ready at 1c06afd2, review clean after 1 fix round, browser proof passed.
