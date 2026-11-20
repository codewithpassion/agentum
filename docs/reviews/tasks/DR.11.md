# DR.11 review: the dream card states what is true now

Branch `task/DR.11-the-dream-card-states-what-is-true-now`. Browser proof: `docs/reviews/tasks/DR.11/browser.md` (verdict pass, both sizes).

## What changed

The card rewrites the stored diary at display time (`currentDiary` in `dream-logic.ts`): the held sentence goes once a batch is decided, an approved batch reads in the past tense, a rejected one keeps "Would add" lines as proposals. `questionsLine` says whether the dream's questions still wait (with the Needs you link) or were answered. To know that, `DreamRun` has a new service-computed `openQuestions` (like `heldChanges`), read in `packages/services/src/dream.ts`. The scope named only the components folder, so this is the one change outside it.

## Verdicts

- Round 1 (0a7fad7): not clean. Must-fix: a questions-only held dream kept its held sentence after the question was answered. Fixed.
- Round 2 (261be68): clean.

## Nits left

- A plain done dream with several kinds of change shows the counts twice in different words ("... and merged 1." and "Added 3 notes, merged 1."), and "Nothing needed changing." sits above "Nothing changed." Both were on main before this task.
- An earlier dream that is still held loses its question sentence and the list shows no replacement line.
- A rejected dream never mentions a question the owner answered before rejecting.
- The stored undo line "You undid this dream." sits under the card's own "You undid this night" line.
- `DreamCardState.done.questions` is no longer read by the card.

## Beyond the scope

- A skill proposal outlives Undo and Reject (DR.12).
- The stale diary could be fixed at the source by writing a state line when the batch is decided; that needs a service change.

## Steps for Dom

None.
