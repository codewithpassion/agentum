---
id: DR.2
title: "Dream steps: merge, reconcile, prune"
milestone: DR
size: L
status: todo
depends_on: [DR.1, ME.2]
branch: null
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
