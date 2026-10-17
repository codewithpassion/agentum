---
id: SK.4
title: Skills page, versions, approvals and assignment in agent config
milestone: SK
size: M
status: todo
depends_on: [SK.1]
branch: task/SK.4-skills-ui
---

Asked for by Dom on 17 Oct 2026. The agent's Skills tab (`apps/web/src/components/agent/tabs/skills.tsx`, `skill-files-panel.tsx`, U.6) edits library files. After SK.1, skills are central and versioned.

## Scope

- A workspace Skills page in the sidebar: every skill with owner, latest approved version, pending proposals count, and the agents it is assigned to. Upload a `.skill` file (new skill or new version), create a skill, download any version as `.skill`.
- A skill's page: file tree and editor for the latest version (reuse the U.6 file panel), saving as one commit with a message; version history with author (person or agent and run) and status; a diff view between any two versions; restore an older version (revert); approve or reject proposed versions, with the diff against their base shown before approving.
- Agent config: the Skills tab lists the agent's assigned skills with their version (latest or pinned), lets you assign existing skills, unassign, and pin or unpin a version, and shows the agent's own pending proposals with a link to review them.
- tRPC procedures over the SK.1 service, `workspaceProcedure` only, thin routers.

## Check

- Browser, with dev login on a local dev server: upload a `.skill` file; edit two files and commit once; see two versions and their diff; restore version 1; assign the skill to a second agent and pin it; approve an agent's proposed version (seed one through the service in a test helper or the dev seed) and see it become latest.
- Router tests for the new procedures.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-17: added at Dom's request.
