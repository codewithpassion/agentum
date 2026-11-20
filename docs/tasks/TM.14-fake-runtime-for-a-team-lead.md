---
id: TM.14
title: "Fake runtime for a team lead"
milestone: TM
size: S
status: todo
depends_on: []
branch: null
lane: runtimes
executor: claude
---

From the teams walkthrough (`docs/reviews/TM-e2e.md`).

Finding. The fake runtime cannot call team tools, so the "lead answers and assigns" and "lead proposes" steps need the rules trick and `team-propose.ts`. Nobody can watch a lead use its tools without a model.

Scope. A third fake mode (like `fake-tool`, KY.9) for a lead's room run: text such as `assign:@handle` makes it call `team_post` and `team_propose_change:<field>=<value>` calls `team_propose_change` through its own run token. Then `team-propose.ts` can go.

Check. A runs test with the scripted text. Browser: the walkthrough with no script.

## Log
- 2026-11-21: added by controller.
