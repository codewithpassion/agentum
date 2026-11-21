---
id: FR.5
title: "Fresh workspace walkthrough"
milestone: FR
size: S
status: done
depends_on: [FR.2, FR.3, FR.4]
branch: null
lane: e2e
executor: claude
---

From `docs/v4/build-plan.md`, milestone FR. The last check: a new person gets from nothing to a working agent.

## Scope

- On a clean local database: sign in, add a key, pick a template, review, create, send a first message, get an answer. Then create a team from a starter.
- Time it and count the nouns on screen. Compare with the friction list in `docs/research/ui-reimagine-2026-11/agentum-inventory.md` section 3 and record which points are gone.
- Findings to `docs/reviews/FR-e2e.md`.

## Check

- The walkthrough passes on local.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-21: dispatched for the end-of-v4 test pass. Findings are recorded only; proposed tasks go to docs/backlog/v4-later unless they are must-fix.
- 2026-11-21: walkthrough done at 864a7e59, merged. It passes at both sizes on Cloud. One must-fix became FR.6. Seven later items are in docs/backlog/v4-later/README.md.
