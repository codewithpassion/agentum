---
id: S.2
title: Skills tab on the agent page
milestone: S
size: S
status: done
depends_on: [S.1, F.3]
branch: task/S.2-skills-editing
---

From the just-bash spike (`harbourmaster-wt/tmp/spike-just-bash/REPORT.md`). Draft, not approved.

## Scope

A Skills tab on the agent page lists the skill folders under `/skills/<agentId>/` and `/skills/_shared/`, with each skill's `name` and `description` from the frontmatter. "New skill" creates `SKILL.md` from a short template. Editing opens the F.3 text editor on that file. Saving a `SKILL.md` validates the frontmatter (`name` and `description` present, `name` matches the folder, description under 1,024 characters) and refuses a bad file with the reason.

Agents can edit their own skills with the F.2 `bash` tool. The service applies the same frontmatter check to library writes under `/skills/`, so a bad edit fails there too.

## Check

Service tests: a valid `SKILL.md` saves, one without `description` or with a mismatched `name` is refused from both the router and the `bash` tool path. In local dev: create a skill on the agent page, run the agent, and the skill is used (same check as S.1).

## Log
- 2026-10-16: drafted from the just-bash spike.
- 2026-10-16: added from the just-bash spike (docs/reviews/spike-just-bash.md). Dom accepted the defaults: library in Harbourmaster on R2, agents write anywhere, agents may edit their own skills, paid Workers plan, 10 MB per file and 1 GB per workspace, just-bash beta with network, Python and JS off.
- 2026-10-16: dispatched on task/S.2-skills-editing.
- 2026-10-16: review clean after 0 fix rounds at 372652a (docs/reviews/tasks/S.2.md). Merged.
