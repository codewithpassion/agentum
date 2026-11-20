# TX.5 review

## Verdict per round

Round 1, commit fadeed5f: must-fix. In a conversation, `requestViews` replaced the fetched record's view with the `request.opened` event's view, which carries no saved answers, so a partly answered queue showed "0 of N" after a reload.
Round 2, commit 9cb22c3f: must-fix. The seed wrote a non-null `seq` on its `request.opened` event, where the service writes null. A queue from a run other than the page's own was still built from the event alone.
Round 3, commit 33258047: must-fix. The mount-time snapshot of saved answers overrode a newer `view.given`, and `DecisionsCard` re-merged `view.given` on every identity change, so a Yes-to-No answer reverted when the thread rebuilt its views. The coordinator allowed a third fix round.
Round 4, commit e5377780: clean. The snapshot is only the base and `view.given` wins over it. The card merges `view.given` only when its content changes. A failed load shows an error. A decision queue cancelled with its run reads "Cancelled", and "Dismissed" only when a person dismissed it.
Round 5, commit ea82a6fa: clean. It shows a saved typed answer in its input after a reload, a defect the browser proof found. Reviewed on its own commit.

Browser proof: `docs/reviews/tasks/TX.5/browser.md`, verdict pass at 1280x800 and 390x844, on e5377780. Its second observation (a saved free-text answer not shown after a reload) is fixed in ea82a6fa and was not re-run in the browser; a unit test covers it.

## What was built

- A `decisions` request is a card in `components/requests/decisions-card.tsx`: expiry line, progress ("1 of 3 answered"), an option button row per question, an input where a question allows free text, Send answers and Dismiss. A partial send keeps the card and shows the saved answers. The last answer or a dismiss closes it.
- The pure logic is in `decisions-logic.ts`: staged picks and typed text, what counts as answered, what is sent (only new or changed answers), what the input shows.
- `RequestView` has a `decisions` variant carrying `given`, the answers saved so far. `viewFromOpened` and `viewFromRecord` build it, `settledFromEvent` reads a closed queue, and a cancelled one carries `dismissed` when the event's actor was a person.
- `RequestCard` draws it, so every surface that draws a request gets it: the Needs you pane and drawer (`NeedsYouBody` case `decisions`), the conversation (`task-state.ts` keeps a record's `given` when the opened event replays), and the room's "Waiting on you" list. The task tab banner offers "Answer decisions".
- `LiveDecisionsCard` calls `requests.answerDecisions` and `requests.dismissDecisions`, fires the rail refresh when the card closes, and loads the saved answers from `requests.pending` once, for a card built from an event alone.
- `scripts/dev/seed-decisions.ts <agentId> [--partial]` seeds a queue and its `request.opened` event in the local D1 for browser checks. It makes no Clerk user.

## Nits left

- Every decisions card fetches the whole workspace pending list on mount, even where the view already has its saved answers, so N cards make N identical calls. `tasks.get` returns only the run's first open request; returning all of them would let the conversation skip the fetch.
- The pending list masks secrets, so the mount snapshot can hold masked text that sits under the real value a send returned.
- When `view.given` changes in content, every key in it overwrites the local answer, not only the changed keys. A stale value that arrives with a new key can revert an answer just sent. The window is narrow.
- `loadFailed` and `saved` are not reset when `view.id` changes, and the load error stays after a successful send.
- `settledFromEvent`'s `actorKind` is a plain string, wider than the actor union.
- The "All answered" and "Dismissed" texts the card sets are never seen, because the parent drops the card in the same tick. The conversation shows the settled line instead.
- Clearing the input of a saved typed answer makes the card look unanswered although the progress counts it. An answer cannot be removed.
- The /desk item pane titles the card "3 decisions" and the heading "Fake echo has decisions waiting" shows only on the drawer row.
- A partial send does not refresh the other surfaces that show the same queue.
- Tests missing: a card-level test of a saved typed answer, unpicking an option to bring back the saved text, and a test file for the seed script.

## Ideas beyond the scope

- Let an agent be told when a queue is dismissed (TX.4 left it silent), with a wake line that says not to raise it again unprompted.
- Return every open request from `tasks.get` so no surface needs its own pending fetch.

## Steps for Dom

None.
