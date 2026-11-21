---
id: TX.7
title: "Team extras walkthrough"
milestone: TX
size: S
status: done
depends_on: [TX.3, TX.5, TX.6]
branch: task/TX.7-team-extras-e2e
lane: e2e
executor: claude
---

From `docs/v4/build-plan.md`, milestone TX. End-to-end check for TX.

## Scope

- Run a three-round discussion in a room. Have the lead raise a decision queue and answer half in the web app and half in the fake Slack. Run a team dream with a seeded conflict.
- Findings to `docs/reviews/TX-e2e.md`.

## Check

- The walkthrough passes on local.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-21: from TX.2: the team dream never reads private notes and there is no way yet for a person to approve sharing one. A dream finding that needs a member change posts a hand-off in the Team diary topic and wakes the lead, who raises the proposal; with no lead it is only a diary line. Check both in the walkthrough.
- 2026-11-21: dispatched.
- 2026-11-21: dispatcher stopped at the account monthly spend limit (HTTP 429). Work is saved in its worktree. Resume the same dispatcher after the limit resets on Nov 25.
- 2026-11-21: spend limit reset, same dispatcher resumed.
- 2026-11-21: ready at 05edee87, review clean. Browser proof: every flow passed at both sizes; the only console errors were database-locked 500s caused by the walkthrough's own scripts holding the local DB file, and a control run was clean (same ruling as TM.10). Controller accepts.
- 2026-11-21: merged 489bd1ca, merge check passed. Done.
