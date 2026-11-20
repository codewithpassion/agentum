# DR.15 review: undo reads in the safe order and closes the run's questions

## Verdicts

- Round 1 (02ca49e): clean, no must-fix. The reviewer moved `ensureUntouched` back above `loadEveryMemoryFile` in a scratch worktree and the new race test failed (undo wrote over the person's note), so the test catches the bug.

## What changed

- `dream/undo.ts`: undo loads the files and etags first and checks the version ids after, as `decide` does. A write that lands in between is refused with `conflict` and the person's note stays.
- A closed question has no status of its own (no schema change in this task), so it is stored as `answered` with `answeredNoteId` null and `answeredBy` set to the person who undid or rejected. Undo closes every open question of the run. Rejecting a held batch closes the run's open questions that name a note a held row touches.
- Tests in `dream/run.test.ts`: the race, undo closing the questions, and a reject that closes one question and leaves another open.

## Nits left

- The reject rule follows the task text, but a held run's questions name notes that already exist, and those notes stay after a reject. A question such as "Tom vs Tom elsewhere" is still valid and gets closed, so the next dream may ask it again. The question that goes stale is the one left open after an approve that merges its note away, and approve closes nothing. Needs a decision.
- Comments still describe the old meaning: `packages/db/src/schema/dreams.ts` (`answered_note_id` is set when a person answers) and `packages/db/src/shared.ts` (`answeredNoteId` is null while open). Both are now also null on a closed question, and `answeredBy` can be the person who undid.
- `dream.answer` says "That question is already answered" for a closed question.
- No test shows undo leaves another run's open question alone, and the reject test does not check `answeredNoteId` or `answeredBy`.

## Beyond scope

- A real `closed` value in `DREAM_QUESTION_STATUSES` (a contract task) so a closed question reads differently from an answered one.
- Close the questions that name a merged or dropped note when a held batch is approved.

## Steps for Dom

None.
