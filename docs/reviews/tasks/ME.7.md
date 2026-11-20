# ME.7 review: Remember button on a message

## Verdicts

- Round 1 (2abed66): not clean. One must-fix: the Remember dialog opens from a menu item, so it has no trigger and focus fell to `body` on close. Fixed in c607ecb by passing `onCloseAutoFocus` to focus the menu button. Also took the nit for the missing `DialogDescription` and the empty actions row under assistant messages (`empty:hidden`).
- Round 2 (fix commit c607ecb only): clean.
- Browser proof, fresh verifier: pass. See `docs/reviews/tasks/ME.7/browser.md` and its screenshots, desktop 1280x800 and phone 390x844.

## Checks

`bun run check` and `bun run build` pass. `bun run test` passes except `apps/web` `guest-execution.test.ts` (live-artifacts), the known workerd flake until FX.1 lands. It also fails when run alone with `fetch failed`, `room.test.ts` in the same run passes.

## Nits left

- No unit test that focus returns to the menu button on close (the browser run covers it).
- The assistant-side wiring (hidden while running, text from text parts only) and the outside-input exclusion on user messages have no unit test. The menu-to-dialog-to-toast flow is covered only in the browser.
- The textarea has no `maxLength` or counter. A note over 500 characters after whitespace collapse shows the server error.
- The message text selector is duplicated in `user-message-container.tsx` and `assistant-message-container.tsx`.
- UI imports in `remember-message.tsx` have no `.tsx` extension, `message-menu.tsx` has them.
- `desktop-6.png` in the browser proof is a bad shot taken after the toast expired.

## Beyond the scope

- The Knows tab does not list notes yet, so "find it on the Knows tab with its source link" was checked through `memory.list` and the library file `agents/<slug>/memory/<kind>.md`. Once ME.6 merges, re-run that one step: the note should show on the Knows tab with its `session:<id>` source link.
- The message menu is the place for later per-message actions. Only Remember is in it.

## Steps for Dom

- After ME.6 and ME.7 are both on main, remember a message in a chat and find it on the agent's Knows tab with its source link.
- The browser run saw an unattributed console 400 (likely the Clerk dev-instance token call) and a phone page that scrolls sideways (424px against 390px) because of the header's Clerk user button. Neither comes from this change.
