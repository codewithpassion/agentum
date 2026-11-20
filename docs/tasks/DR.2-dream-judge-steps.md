---
id: DR.2
title: "Dream steps: merge, reconcile, prune"
milestone: DR
size: L
status: done
depends_on: [DR.1, ME.2]
branch: task/DR.2-dream-judge-steps
lane: services-dream
executor: claude
---

From `docs/v4/build-plan.md`, milestone DR. Port the judging steps from The Brain. Source: `/home/roboto/devel/the-brain/packages/db/src/dream/` (`dedup.ts`, `contradiction.ts`, `hygiene.ts`, `judge.ts`, `plan.ts`). They work on The Brain's fact and entity tables. Here the input is `MemoryNote[]` plus candidate notes, and the output is a `DreamPlan`.

## Scope

- Create `packages/services/src/dream/steps/`: `merge.ts` (duplicates and near duplicates into one note), `reconcile.ts` (two notes that disagree: the newer note written by a person wins, otherwise emit a question), `prune.ts` (finished work notes, notes unused for 60 days, and merging to stay under the size budget).
- Each step is a pure function over notes with an injected `judge` for model calls, as The Brain's `judge.ts` does. Copy the prompts and adapt the wording to notes.
- The repo rule applies: a copied file comes in with its tests. Port the matching tests and note in each file header which Brain file it came from.
- Leave out entity pages and indexes. They have no match here.
- A note with `written_by: dream` is never counted as fresh evidence for another change.

## Check

- Step tests with a fake judge: exact duplicate, near duplicate, person beats agent, unclear conflict becomes a question, prune by age, budget kept by merging.
- The dream-output-is-not-evidence rule has its own test.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/DR.2-dream-judge-steps (v4 controller session).
- 2026-11-20: controller decision on prune by age (Dom's "don't wait for me"): there is no last-used date, so the note's date stands in for use, but notes written by a person are never pruned by age. Only agent-written notes older than 60 days go. A fourth round is allowed for this and the groups.ts fix.
- 2026-11-20: merged as 9f865f20, review clean after 3 fix rounds (round 4 clean). check, test and build passed on main. Prune by age skips person-written notes.
