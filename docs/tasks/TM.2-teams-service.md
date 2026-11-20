---
id: TM.2
title: "Teams service: members, lead, shared folder"
milestone: TM
size: M
status: in_progress
depends_on: [TM.1]
branch: task/TM.2-teams-service
lane: services-teams
executor: codex
---

From `docs/v4/build-plan.md`, milestone TM. Fill `@repo/services/teams`.

## Scope

- Create, update and archive need an admin or the team's owner. A team has at most one lead, and the lead must be a member agent.
- An agent may be in several teams with exactly one home team. A person may be in any number.
- Creating a team makes the library folder `teams/<slug>/` and grants read and write to member agents through `agent_library_access`. Removing a member removes the grant.
- `profiles.set` lets a person set their name and handle. Handles are unique in a workspace and match the mention pattern in `inbox/mentions.ts`.
- `roster.list` returns `teamId` (home team) and `isLead`.

## Check

- Service tests: authz, one lead, home team rule, folder grants on add and remove, handle clash.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/TM.2-teams-service (v4 controller session).
