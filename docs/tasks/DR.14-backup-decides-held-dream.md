---
id: DR.14
title: "The backup owner decides a held dream batch"
milestone: DR
size: S
status: ready
depends_on: [ME.18]
branch: task/DR.14-backup-decides-held-dream
lane: services-dream
executor: claude
---

From the ME.18 review (`docs/reviews/tasks/ME.18.md`). ME.18 let the backup decide held notes and dream questions, but left `dream.decide` (the held dream batch and its `dream_held` card) as owner-or-admin.

## Decision

Controller decision (20 Nov 2026): the backup owner decides a held dream batch too, the same as held notes and dream questions.

## Scope

- `dream.decide` accepts the agent's owners, its backup and workspace admins.
- The `dream_held` card reaches the backup after the usual owner-then-backup escalation, and nobody else beyond owners and admins.

## Check

- Service tests: owner, backup and admin can decide a held batch; a plain member is refused and memory is unchanged.
- Rail test: the backup gets the `dream_held` card after the escalation delay; a plain member never does.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-21: added from the ME.18 review.
- 2026-11-21: dispatched. Ready at a7431514, review clean with no fix rounds. Nit: the Knows tab still hides Approve and Reject from the backup.
