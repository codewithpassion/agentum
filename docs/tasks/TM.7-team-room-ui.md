---
id: TM.7
title: "Team room UI: topics and posts"
milestone: TM
size: L
status: done
depends_on: [TM.1]
branch: task/TM.7-team-room-ui
lane: web-room
executor: claude
---

From `docs/v4/build-plan.md`, milestone TM. Mockup: the centre column of Proposal B. Reuse `components/inbox/*` where it fits.

## Scope

- New route `/teams/$teamId/room` with components in `components/room/`: topic list on the left, posts in the centre, composer with mention completion for member agents and people.
- A post shows its author with avatar, and chips that link to its task, files and artifacts when the server returned them.
- Requests raised in a room task render inline with their buttons, reusing `components/requests/*`.
- "Assigned to" line under a lead post that mentions members.
- New topic dialog with an optional member subset.
- Phone layout: topics as a sheet.

## Check

- Component tests for a post with links and for the mention completion.
- Browser with the fake runtime: post, mention an agent, see its reply and its task link, answer an inline approval.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/TM.7-team-room-ui (v4 controller session).
- 2026-11-20: merged as 202c86f2, review clean after 3 fix rounds. Browser proof passed at both sizes: docs/reviews/tasks/TM.7/browser.md. check, test and build passed on main. The team page's Room link is in TM.11.
