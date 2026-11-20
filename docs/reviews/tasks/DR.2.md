# DR.2 review

## Verdict

Round 1, commit 0bfeda0c: must-fix. Six items. A merge keeper became dream-written even when its text did not change, so a person's note lost its standing and could be folded into an agent's note. A note a question waits on could be dropped or merged by prune in the same plan. Adds are not in `notes`, so the size budget did not count them. A question's scope and the writer rule were undocumented. Age pruning dropped person-written notes (kept on purpose in round 1, see round 4).
Round 2, commit 5940b049: must-fix. The rule "a merge that leaves the text unchanged keeps the keeper's writer and date" was assumed by the steps but not stated for DR.4.
Round 3, commit ddee5942: must-fix. `notesAfterMerge` compared text after `normalizeText` while the rule and the plan used exact text.
Round 4, commit 621678d7 (after bc5b81f6 and 621678d7): clean. No must-fix findings. The round was allowed by the controller after two fix rounds.

The fixes: `pickKeeper` ranks person, agent, dream, then oldest. `notesAfterMerge` leaves a keeper whose text is unchanged as it was. `mergeChange` emits the keeper's own text when the new text equals it after normalizing. Reconcile returns `held` and prune leaves held notes alone. Prune never ages out a note a person wrote (the controller's call, with a test). The stale-drop reason reads "Not changed for 60 days", because `date` is the last write.

## For the downstream tasks (DR.4)

- An empty-absorbed `merge` is an edit in place of the keeper's text. `DreamPlan` has no edit action and `codec.apply` rejects a merge with nothing absorbed, so apply it as an `edit`.
- A `merge` whose text equals the keeper's text leaves the keeper's `written_by` and date as they were. Only a merge that changes the text writes the keeper as `dream` with the day of the dream. The steps' `notes` output assumes this.
- A question's scope comes from its `noteIds`: they are one kind and one `userScope`. The question text carries note text, so a private note's question belongs to that person alone.
- Pass `maxChars` to prune as the budget less the text the plan adds. Added notes have no id, so they are not in a step's `notes`.
- Pass reconcile's `held` ids to prune so a questioned note is never dropped or merged in the same plan.
- Run the steps in the order merge, reconcile, prune, each on the previous step's `notes`. Apply the plan changes in order.
- `mergeNotes` takes candidates (the `add` shape) and returns `skippedGroups`, the groups whose judge answer was unusable. Candidates with text that fails the note rule are dropped.

## Decisions made

- No similarity engine. Exact duplicates are text equality in code. Near duplicates and conflicts go to the judge one group of one kind and one `userScope` at a time, and the judge only names ids and text.
- Reconcile's winner is decided in code: the strictly newest note wins only when a person wrote it and the judge's confidence is at least 0.7. Anything else is a question.
- A dream-written note is never fresh evidence: a group with none is not judged, and such a note never wins a conflict. It can still be aged out or condensed. A dream-written note is the last choice for the note a merge keeps.
- The finished-work judge call runs once per scope group, not once for all notes, so one person's private note never shares a call with another group.
- Judge calls for the different groups of a step run concurrently.
- The steps are not added to `package.json` exports. DR.4 imports them from inside the package.

## Nits left

- `prune.ts`: dream-written notes still age out after 60 days, although the controller's wording was "only agent-written". A dream-written note can hold a person's words after a merge changed its text. Decide whether to spare them too.
- `groups.ts` comments say "exact duplicate"; the rule now covers text equal after `normalizeText`.
- `prune.ts` header gives "the newer word of a person wins" as the reason for sparing person notes. The better reason is that a person put the note there on purpose and the date is no use signal.
- No test runs a normalize-equal merge through `notesAfterMerge`.
- A candidate merged into an existing note loses its `source`. The merge change has none.
- A conflict with low confidence still becomes a question, so a hedging judge can send the owner many questions.
- A judge call that fails leaves memory over budget until the next dream.
- Note text goes into prompts as written, so a note could carry instructions to the judge. Ids, confidence and text are validated afterwards.

## Beyond the scope

- A candidate that contradicts an existing note is added unchecked. The next dream sees it as a dream-written note, and reconcile then asks a question. A same-night check needs candidate ids.
- Age pruning needs a real use signal, such as recall counts, to match The Brain's hygiene pass.

## Test notes

- 68 step tests in `packages/services/src/dream/steps/`, one file per step plus `judge`, `groups` and `evidence`. They map to the task's check: exact duplicate, near duplicate, person beats agent, unclear conflict becomes a question, prune by age, budget kept by merging, and the dream-output-is-not-evidence rule (`evidence.test.ts`).
- The Brain's tests are canary tests on D1 and cannot be copied. The test headers name the canary cases each one ports (tenant isolation, anti-loop, low confidence downgrade, kinds never mixed, the degrade path).

## Steps for Dom

- None.
