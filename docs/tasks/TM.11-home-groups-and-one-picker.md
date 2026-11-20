---
id: TM.11
title: "Home hides empty team groups; one member picker"
milestone: TM
size: S
status: in_progress
depends_on: [TM.6, TM.8]
branch: task/TM.11-home-groups-and-one-picker
lane: web-home
executor: claude
---

From the TM.8 review (`docs/reviews/tasks/TM.8.md`). Every workspace has an "Everyone" team that can't be archived, so home always shows team groups. On a fresh workspace that means an empty "Everyone" group, and the flat wall can't be reached. TM.8 also built its own member picker in `components/roster`, because TM.6's picker wasn't on main yet.

## Scope

- Home hides a team group with no agents. When "Everyone" is the only team with agents, home shows the flat card wall without group headings (controller decision, 20 Nov 2026).
- Use one member picker: keep TM.6's in `components/team` and have home use it, deleting the copy in `components/roster`. If a shared place outside both folders fits better, put it there.
- The team page (`components/team/`) links to its room at `/teams/<id>/room` (from TM.7: nothing links there yet).

## Check

- Component tests: empty groups hidden; only "Everyone" with agents shows the flat wall.
- Browser at desktop and phone on a fresh workspace and one with two teams.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the TM.8 review.
- 2026-11-20: scope adds the team page's Room link, from TM.7.
- 2026-11-20: dispatched on task/TM.11-home-groups-and-one-picker (v4 controller session).
