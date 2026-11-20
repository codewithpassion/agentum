# ME.6 review: Knows tab

## Verdicts

- Round 1 (2a15efda): not clean, 1 must-fix. The two-column grid gave no section a column, so Skills, Instructions and Voice were split across both columns.
- Round 2 (40c189dd, fix only): clean. Each column is its own stack, and on a phone `max-lg:contents` with `order` shows notes, rules, learned, skills, instructions, voice. The fix also hides merge rows from Learned this week and from held rows, because the service decides and undoes those with their dream, and `changeWhen` counts local days.
- Browser proof (bb5fbe11): pass at 1280x800 and 390x844, see `docs/reviews/tasks/ME.6/browser.md`. It covers add, edit, forget, Undo, the learn level as owner, a member with every rules control disabled (and the server refusing `rules.set` with 403), held notes with Approve and Reject, and the empty dream slot.

Checks run by the dispatcher: `bun run check` and `bun run build` pass. `bun run test` ran every package. It failed twice on tests that pass or fail for host reasons: the services test "an hour of never-claimed runs stays bounded" timed out at 63 s under load and passes alone (174 tests), and `guest-execution.test.ts` in `apps/web` fails with a miniflare ECONNRESET, alone as well as in the full run. The other 4601 web tests and `bun test scripts` pass.

## What the spec left open

- RH.5 (the Right now panel) is not merged, so its Learned this week slot does not exist. Learned this week sits in the right column of the Knows tab. `knows/learned-this-week.tsx` exports `LearnedList`, and `learnedThisWeek` in `learned-logic.ts` filters the data, so the slot can use both when RH.5 lands. Data comes from `memory.changes` with `since` set to seven days ago.
- Dream schedule is not here. DR.6 owns it. The dream card slot is `<div data-slot="dream-card">` at the top of `knows-layout.tsx`, empty and hidden while empty.
- At the Quietly level, agent and dream changes are left out of Learned this week, as the design doc says ("shows them only in the diary"). A person's own changes stay, so a hand-made forget can be undone.
- A request source links to `/desk`, because requests have no page of their own.

## Nits left

- Learned this week windows on `createdAt`, so a held change approved today but made more than seven days ago does not show.
- The add form, note edit and rule draft clear before the save finishes, so a failed save loses the typed text. A failed save shows the error above the notes.
- Adding a duplicate, too long or 51st rule does nothing and says nothing.
- An agent Never rule that repeats a workspace rule is hidden and cannot be removed.
- The tab loads once and after each action. It does not poll, so a new held note from a running agent shows after a reload.
- On a phone `order` changes the visual order only. Keyboard and screen reader order follow the DOM.
- Edit, Forget and Remove buttons have generic accessible names. The note Edit button shares its name with the header's Edit.
- No test checks which column holds each section.
- Held merges have no place in the UI until DR.6, and `docs/v4/memory-format.md` says a decision on one row of a group acts on the whole group while the service refuses it. Reconcile in DR.6.
- In dev builds the TanStack Devtools button covers a control at the bottom right.

## Ideas beyond the scope

- Mount `LearnedList` in the RH.5 slot and open each source link on the exact message or request.
- A "Remember" count on the tab bar from `roster.list`'s `learnedCount` (ME.8).

## For Dom

Nothing needs your accounts. The browser proof added a user `dev+member@harbouredgeintelligence.ai` (org member) to the Clerk dev instance and to Dev Workspace. Delete it there if you do not want it.
