# AB.2: Agent page, the few settings that matter first

## What changed

The profile card shows Does, Owner, Tools and Starts on. The side column shows Runs on and the ask level. Hands to, Subagents and peers share one Works with block, each with a line on what it does, and the Hands to copy says it is a suggestion to the agent. Voice, Skills, Library and Channels sit behind More. The ask overrides and a button into the model, environment, network and turn limit sheet sit behind Advanced. The Connections card moved into Works with as Peers. The map inspector still uses the profile card and shows no Peers.

Screenshots in `docs/reviews/tasks/AB.2/`: `before.png`, `after-closed.png`, `after-open.png` (local dev server, dark theme, 1280px wide).

## Review

- Round 1, commit bc658013: not clean. Must-fix: More and Advanced could not open on an archived agent (the page fieldset disables the trigger), and the Advanced title broke mid-word in the first screenshot.
- Round 2, commit 3032883: More starts open on an archived agent, screenshot retaken. Not clean, Advanced had the same archived problem.
- Round 3, commit 729a5a7: Advanced starts open on an archived agent. Clean.

## Nits left

- `defaultOpen` only counts on first mount. If an agent were archived while its page stays mounted, the sections stay closed until a remount.
- No test renders `AskBeforeCard` or `ProfileRows` with `archived`. Those need Clerk and router mocks, and `mock.module` leaks across test files in one bun process. `disclosure.test.tsx` covers the mechanism.
- The Peers wrapper restyles `ConnectionsCard` from the route (`-mx-4`, border and heading overrides), and the card keeps its own landmark and hidden heading.
- The Peers copy and the card's "No connections" text explain the same thing.
- Three buttons open the same settings sheet: Edit in the header, Advanced in the Runs on card (RT.2's card, left alone), and the new button in Advanced.
- `AskBeforeCard` now renders the ask card and the Advanced card, because both share the ask state. The name no longer fits.

## Ideas beyond the scope

- Show the current model, environment, network and turn limit as plain text inside Advanced, so the sheet is only for changing them.
- Lift the ask state into a hook so the Advanced card can live apart from the ask card.

## Not verified

- Staging checks in the task file (controller runs them after the merge).
- Mobile width, and the light theme, were not screenshotted.
- Full `bun run test` once failed on `src/server/live-artifacts/guest-execution.test.ts` (Miniflare "other side closed" after about 90 s), and it failed again alone in one run and passed in another. The change touches no server code. `bun run check` was killed by exit 137 (out of memory) twice when run with the default heap, and passes with `NODE_OPTIONS=--max-old-space-size=8192`.

## Steps for Dom

None.
