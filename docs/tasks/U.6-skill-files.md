---
id: U.6
title: Edit a skill's other files on the Skills tab
milestone: U
size: S
status: done
depends_on: [S.2]
branch: task/U.6-skill-files
---

Found in the C.12 staging check on 17 Oct 2026, approved by Dom. The agent's Skills tab (S.2) edits only `SKILL.md`. A skill's scripts and other files (`scripts/*.ts` and so on) have to be uploaded through `/library` into `skills/<agentId>/<skill>/`.

## Scope

On the Skills tab, show each skill's file tree. Let the user add a new text file by path, edit a text file in place, upload files (including binary ones), and delete a file, all within that skill's folder. Use the existing library services and their caps (10 MB per file, 1 GB per workspace, and S.1's limits on skill size). Reject paths that leave the skill's folder. Use existing shadcn components only.

## Check

Service or router tests: a file added under a skill shows up in its tree, an edit changes it, a delete removes it, and a path with `..` or an absolute path is refused. Browser, dev login on a local dev server: create a skill, add `scripts/hello.ts` from the tab, edit it, upload a small PNG, delete the PNG, and see the tree update. `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-17: added from the C.12 staging check (Dom: yes); dispatched on task/U.6-skill-files.
- 2026-10-17: review clean after 2 fix rounds at 1213b8f (docs/reviews/tasks/U.6.md). Merged.
