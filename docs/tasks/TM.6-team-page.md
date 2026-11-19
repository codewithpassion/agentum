---
id: TM.6
title: "Team page: members, lead, rules, folder"
milestone: TM
size: M
status: todo
depends_on: [TM.1, RH.4]
branch: null
lane: web-team
executor: claude
---

From `docs/v4/build-plan.md`, milestone TM. Mockup: the right column of Proposal B in the report.

## Scope

- New route `/teams/$teamId` with components in `components/team/`: members (agents and people) with add and remove, lead picker, team rules editor, shared folder link, standing jobs of member agents (from `jobs.list` when it exists, else hidden).
- "New team" dialog: name, members, lead.
- "How the team knows you": the person's name and handle, from `teams.profiles`.
- Three plain choices on the agent's Settings tab for capability (model), thinking level and context size, writing `runtimeConfig`.
- Add the page to `find-registry.ts`.

## Check

- Component tests for the member list and rules editor.
- Browser: create a team, set a lead, edit rules, set your handle.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
