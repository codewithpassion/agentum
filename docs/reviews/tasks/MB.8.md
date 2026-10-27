# MB.8 review: mobile fixes from the re-audit

## Verdicts

Round 1 at 0316e2a: not clean, three must-fix items. The map Undo after unplug re-plugged with default tool limits and pins, the "Agents" crumb on New agent had no 40px target, and the skill version selects stayed 32px on touch. Round 2 at 4da39d3d (fix commit only): clean.

## What changed

- N-01: `min-w-0` on the `SidebarInset` main in `routes/_app.tsx`, so a wide table no longer widens the page. Checked 19 routes at 1280 and 1024: `scrollWidth` equals the viewport on all of them. The local data has no wide connector or secret rows, so the old overflow was not reproduced here. The fix follows from the flex rule that a column child needs `min-w-0`.
- F-13: a phone-only fixed "Reply" bar on the task page (`thread/reply-bar.tsx`). It scrolls the Thread card into view and focuses the message box, and hides while the message box is on screen. The box stays disabled until the run starts, so focus lands only on a live task.
- F-18: on phones the map fits at zoom 1 (`minZoom` 1) and node text is 12px. Desktop zoom is unchanged.
- N-02: inputs and native selects are 40px on coarse pointers, in `styles.css` next to MB.1's rules. Checked at 390 with touch: Log and Sessions fields are 40px.
- N-03: 40px targets for "All tasks", "All skills", the Agents crumb, the task header agent chip, "Open in library", the approval "Input" disclosure, the Clerk avatar and the skill version selects.
- N-04: tap-to-plug shows an "Undo" toast. Map inspector "Remove" and "Unassign" in the Skills sheet ask first. A confirm replaced the undo toast for Remove because plugging back in cannot restore tool limits or pins.
- N-05: question choices are 16px, full width on phones. "Always allow" is its own bordered row at the bottom with a hint.
- N-06: the settings nav wraps to two rows on phones, so every item shows. Desktop is unchanged.
- N-07: the Links cell in the Log phone card has a "Links" label.

## Screenshots

In `docs/reviews/tasks/MB.8-shots/`: `phone-settings-nav-390.png`, `phone-log-390.png`, `phone-map-390.png`, `phone-task-reply-bar-390.png`, `desktop-connectors-1280.png`, `desktop-log-1280.png`, `desktop-map-1280.png`. Phone shots use Playwright with `hasTouch` and `isMobile` at 390x844, so `pointer: coarse` matched. The data is a copy of the controller's older local database.

## Nits left

- `LINKS_LABEL_CLASS` in `log/log-table.tsx` copies the label classes from `responsive-table.tsx`. A `label` prop on `ResponsiveActions` would remove the copy.
- The Reply bar looks up the message box once, on mount. If the composer renders later, the bar watches the whole card.
- `reply-bar.test.ts` covers only the scroll-behaviour helper.
- The approval "Input" summary text sits at the top of its 40px row.
- One `@repo/services` test ("an hour of never-claimed runs stays bounded") took 48s of its 60s timeout in the reviewer's full run. MB.8 does not touch services.

## Ideas beyond the scope

- A pinch-zoom and on-screen keyboard pass on a real phone, still open from the audit.

## For Dom

Nothing needs your accounts. A look on a real phone at the Reply bar over the keyboard and at the map text size would still help.
