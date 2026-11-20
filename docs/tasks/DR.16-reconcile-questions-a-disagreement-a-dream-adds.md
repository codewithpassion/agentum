---
id: DR.16
title: "Reconcile questions a disagreement a dream adds"
milestone: DR
size: M
status: in_progress
depends_on: [DR.10, DR.9]
branch: task/DR.16-reconcile-questions-a-disagreement-a-dream-adds
lane: services-dream
executor: claude
---

Split from DR.10. Its dispatcher found that a disagreement the dream itself finds never becomes a question.

## Finding

Reconcile runs on `merged.notes`, which holds only notes that already exist. A question has to name existing note ids, and new candidates have none until they are applied. Reconcile also skips any group whose notes a dream wrote, so a later dream never questions them either. With DR.10's prompt, two conflicting facts (invoices paid on Thursdays and on Fridays) come out as two candidates, the dream adds both notes, and no question is asked, on that dream or the next.

## Scope

In `packages/services/src/dream/run.ts` and `steps/reconcile.ts`, let reconcile judge the dream's new candidates together with existing notes. When candidates disagree, apply their adds first and then raise the question naming the new note ids. Keep the dream-only skip for groups that a question already settled, so a person isn't asked the same thing twice.

## Check

- Reconcile tests with a fake model: two disagreeing candidates in one dream raise one question naming both new notes. A group already settled by an answered question raises none.
- A real-model run (claude-haiku-5-5) of two disagreeing conversations ends with a question in Needs you. Its cost is in the diary's usage row.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-21: added by controller, split from DR.10.
- 2026-11-21: dispatched.
- 2026-11-21: ready at f71d97f7, review clean with no fix rounds. The real-model run (claude-haiku-5-5, $0.0005) ended with an open question naming both new notes. Known limit: a held batch (ask first, or outside evidence) still raises no question about notes it would add. Queued for merge.
