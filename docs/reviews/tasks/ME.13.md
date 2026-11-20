# ME.13 review: a way to start a private conversation

## What was built

The New conversation dialog (Desk and agent room) has a Private switch, off by default. It sets the new session's `private` flag. The browser's `runs.start` now accepts `session.private`, with the origin still forced to `ui`. The Knows tab shows a Private badge on the person's own private notes and on a held private change. The service already hid other people's private notes from Knows and the Library, and still does.

## Verdicts

Round 1 (reviewer on 5400d79): clean, no must-fix. Zero fix rounds.

Browser proof (fresh verifier, `docs/reviews/tasks/ME.13/browser.md`, 1280x800 and 390x844): pass. Flows A to E passed at both sizes. The verifier saw one Clerk 400 in the dev user's console right after the first dev login. That is the dev-login sign-in call already described in `docs/reviews/ME-e2e.md` ("Console and network"), not a page of this task.

## Nits left

- `runs-router.ts:19`: the browser may send `externalKey` with `private`. On an existing session `private` is ignored. A person could make their own `main:<self>` thread private by creating it first. It only affects that person.
- `new-task-dialog.tsx:181`: the help text under the switch has no `aria-describedby`.
- `new-task-dialog.tsx:78`: closing the dialog without starting keeps the switch on, like the text and agent choice.
- Verifier: a member can see that an empty `private` folder exists under `agents/<slug>/memory/` in the Library (name only, no contents).

## Ideas beyond the scope

- Mark a private conversation as private in the thread header and in the sessions list (it shows as "UI" today).
- A Private switch on the empty-thread composer of the main chat (`empty-thread.tsx`).
- Hide the empty `private` folder from other members in the Library.

## Steps for Dom

None.
