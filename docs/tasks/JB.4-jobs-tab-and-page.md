---
id: JB.4
title: "Jobs tab and the workspace Jobs page"
milestone: JB
size: M
status: in_progress
depends_on: [JB.1, RH.4]
branch: task/JB.4-jobs-tab-and-page
lane: web-jobs
executor: claude
---

From `docs/v4/build-plan.md`, milestone JB. Mockup: Proposal C in the report, used here as a tab and a list page.

## Scope

- `components/agent/room/jobs/`: the agent's jobs as sentences made of chips, each with pause, edit, run now, and last result. A text box "Describe a new job" calls `jobs.draft` and shows the draft for review before saving.
- New route `/jobs` listing all agents' jobs. `/routines` and `/triggers` redirect to it. Edit forms reuse `components/routines/*` and `components/triggers/*`.
- Workspace timezone field in Settings for admins, using `workspaces.setTimezone`.
- Update `find-registry.ts`: one entry "Jobs".

## Check

- Component tests for the sentence row and the draft review.
- Browser: describe a job, save it, run it now, pause it.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: from JB.3: once this tab shows drafts, Dom tries "Every Friday, summarise support tickets for me" against the live Anthropic key. The drafter has only run against a fake model so far.
- 2026-11-20: dispatched on task/JB.4-jobs-tab-and-page (v4 controller session).
