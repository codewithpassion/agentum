# DR.7 review: Dream walkthrough

Branch `task/DR.7-dream-e2e`. The task is a walkthrough, so the code is small: `scripts/dev/seed-dream.ts` and one change in `packages/services/src/dream/run.ts` with a test. The findings of the walkthrough are in `docs/reviews/DR-e2e.md`. The browser proof is `docs/reviews/tasks/DR.7/browser.md`.

## Verdicts

- Round 1, commit fcc373ea: not clean. One must-fix: the seed script backdated sets 2 to 4 (and round 2's set 1) by up to 43 seconds, and a dream reads only rows newer than the last dream's start, so a seed run soon after a dream could be skipped.
- Round 2, commit ee4dc8d4 (the fix): clean. Fresh sets are stamped at now, a millisecond apart, and the session key carries the time.
- Browser proof, first pass: blocked, because a local database file had been restored without its WAL file and lost the stored key. Second pass: one failing flow (phone flow 7), caused by seed data that tripped the never list and by two rounds sharing one agent. Third pass on commit 0633d667: pass, every flow at both sizes.

## Nits left

- `seed-dream.ts`: conversations start 1 ms apart but each spans 2 ms, so two neighbours can swap one message in the dream's input. Cosmetic.
- `seed-dream.ts`: `gap` and the `ago` arguments of sets 2 to 4 are dead since the fix, and the doc on `Chat.ago` holds only for round 1 set 1.
- `seed-dream.ts`: the `--owner` update runs before the transaction, so a failed insert keeps the owner change. The procedure destructuring appears twice. Events are written with a null `seq`.
- Running round 1 set 1 twice now seeds a second nine-day history, because the key carries the time.

## Ideas beyond the scope

DR.9 to DR.13 in `docs/reviews/DR-e2e.md`: a correction meets the older note of another kind, extract keeps a disagreement for reconcile, the card states what is true after Approve, Reject and answer, Undo and Reject clean up a skill proposal, and a scripted model for Dream now on local.

## Steps for Dom

None. The real-model run needed only the dev key, which went into the local database through Settings. Total real-model cost of the 24 dreams: $0.023.
