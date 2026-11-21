# RH.10 review

Round 0, commit 6a549c5: clean. No must-fix items.

Browser proof: `docs/reviews/tasks/RH.10/browser.md`, pass at 1280x800 and 390x844.

## Nits left

- The closed-state test asserts both `not.toContain("Find")` and `toBe("")`. The first is redundant.
- The open state has no test, because server rendering cannot show the dialog's content. The browser run covers it.
- The scope says "from `Dialog` and `Command`". `Command` stays in `find-dialog.tsx`, which keeps the wrapper to the dialog shell.
- The browser run saw one console `400` when `/api/dev-login` ran on a profile that was already signed in. It did not occur in the Find flows. Likely a Clerk sign-in token reuse on a live session, not this change.

## Beyond scope

None.

## Steps for Dom

None.
