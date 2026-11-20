# RH.6 review: one top bar and a Needs you drawer

## Verdicts

- Round 0, commit b8da4757: must-fix. The desktop bar started at 768px but needed about 1030px, so it overflowed sideways.
- Round 1, commit 37b07b56: the full bar now starts at lg (1024px), the workspace slot is narrower, the shortcut hint hides below xl. Must-fix: Spend would overflow once it appears.
- Round 2, commit 0aedea2e: Assistant and New agent are icon-only below xl, bar height back to md, workspace slot w-56. Clean.
- Browser proof (fresh verifier, `docs/reviews/tasks/RH.6/browser.md`): pass at 1280x800 and 390x844, plus 1024x768 for the bar. `scrollWidth` equals `innerWidth` on every page, including a thread page at 390px (the case the KY walkthrough raised: the old header nav pushed the user button to 424px; the new phone bar holds only Home, Needs you and Menu, and has no role-dependent items, so it is the same for admin and member).
- After the browser pass: the empty-state copy "show up on the left" now says "under Needs you".

## What shipped

`shell/top-bar.tsx` (presentational) and `shell/app-top-bar.tsx` (wiring) replace the rail, its footer tabs and the site header on signed-in pages. The Needs you button opens `rail/needs-you-drawer.tsx` on every page. `useNeedsYou` holds the count and runs above the drawer. The phone bar is Home, Needs you and a Menu sheet. Spend appears once a `/spend` route exists. The phone menu lists the account actions itself, because Clerk's user popover is blocked by a sheet's focus trap. `PinnedSidebarGroup` is plain markup now. `find-registry.ts` needed no change: every page the old footer tabs reached (Agents, Apps, Files as Library, Settings) was already a Find entry, and `top-bar-logic.test.ts` checks that every top bar page is in Find.

## Nits left

- `components/ui/sidebar.tsx` has no importer now. It is shadcn output, so it stays.
- The artifact viewer menu still says "Pin to sidebar" and "Pinned to sidebar". Those pins now show in the Needs you drawer.
- `data-label` on the top bar buttons is a generic attribute name. A more specific one would avoid a clash with the responsive tables.
- The drawer and Menu sheets open from plain buttons, not `SheetTrigger`, so closing drops focus to the body.
- A long workspace name wraps inside the bar's `w-56` slot.
- `docs/ux-review/rail/spec.md` still describes the permanent rail.
- The "Needs you" heading shows twice in the drawer (sheet title and list heading).
- The floating palm-tree button covers Send on the phone composer. It is not part of this diff.

## Ideas beyond the scope

- Land on `/home` after a workspace switch, invitation accept and the picker (`use-switch-workspace.ts`, `accept-invitation.tsx`, `picker-redirect.ts` still use `/desk`).
- Show the Needs you list beside the item pane on desktop `/desk`, since the permanent rail no longer does.
- Move the Mine/Everyone toggle next to the Desk pane, because the pane follows it but it now lives in the drawer.
- Rename the Find entry Library to Files, or the top bar link to Library, so the two agree.

## Steps for Dom

- Confirm that dropping the permanent list from desktop `/desk` is what you want, and that Board and New conversation leaving the global bar is fine (Board stays in Find and the "done today" link, New conversation on the Desk and in the agent room).
- Test flakes seen on the build machine under load: `@repo/services` "an hour of never-claimed runs stays bounded" timed out at 63s in one full run and passed alone, and `guest-execution.test.ts` failed under load (load average about 10) and passed in the first full run.
