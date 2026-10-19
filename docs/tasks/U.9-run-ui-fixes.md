---
id: U.9
title: Run and agent UI fixes from the R.2 staging check
milestone: U
size: S
status: in_progress
depends_on: []
branch: task/U.9-run-ui-fixes
---

Asked for by Dom on 19 Oct 2026, from the R.2 staging check (screenshots in `/home/roboto/devel/harbourmaster-wt/tmp/R2-check/`).

## Scope

1. A queued run of a cloud agent says "Queued, waiting for the machine". Use wording per runtime: machine agents keep "waiting for the machine"; cloud and managed agents say "Queued, waiting for the agent's current run to finish" (or "Queued" alone if nothing is running).
2. The Log shows Cancel on two rows for one active run. Show it once per run, on the newest row of that run that is still active, or on the run's row in a run-grouped view if one exists.
3. The Log shows a raw Clerk user id as the actor (for example "Cancelled by user user_3Kk8…"). Show the person's name, or their email when there's no name, using the directory lookup the app already has for members. Fall back to the id only when the person can't be found.
4. Agents have no archive button. Add "Archive agent" to the agent's config (or its menu), with a confirm dialog naming the agent, calling the existing `agents.archive` procedure, then return to the agent list.

## Check

- Component or router tests for each item where the code is testable; the actor name lookup has a test for found, no name (email) and not found (id).
- Browser, with dev login on a local dev server: a queued cloud run shows the new wording, one Cancel per run in the Log, a name as the actor, and archiving an agent removes it from the list.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-19: added at Dom's request. dispatched.
