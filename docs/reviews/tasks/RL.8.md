# RL.8 review

Scope: M4 and M5 from `docs/reviews/RL-2.md`.

## Round 1, commit b76f2d2b

Not clean: 1 must-fix. `use-elsewhere.ts` kept its verdict when an id was opened again, so the pane could show `under Everyone` from the last opening until the new check landed. Fixed in 15a1cf4c: the verdict resets in render whenever the missing id or scope changes. The same commit titles other runs by the first line of their post.

## Round 2, commit 15a1cf4c

Clean. The re-review found that the new reopen test passed even without the fix. It now keeps the Everyone check held open and asserts `Looking for that item.`, and it fails with the reset removed.

## Nits left

- A run whose input starts with a newline gets an empty title in `otherRuns` (`packages/services/src/sessions.ts`, `runTitleFor`). Inbox posts are trimmed, so a thread does not hit it. `desk.ts` falls back to `Task`.
- The pane now refetches on every `item` change, so an answer loads twice (the item change and the refresh event), and the bare `/desk` auto-open adds one load. `usePolledQuery` sequences them.
- If the refetch after a click fails, `Looking for that item.` stays beside the error banner until a later load succeeds.
- The M3 browser check from `RL-1.md` has still not been run in a browser.

## Ideas beyond the scope

None.
