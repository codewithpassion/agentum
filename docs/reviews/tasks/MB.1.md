# MB.1 review: mobile shell and global rules

Screenshots: `docs/reviews/tasks/MB.1-shots/` (desk-390, nav-390, settings-390, machines-390, create-routine-390x664, machines-1280).

## Verdicts

- Round 1 (471131d): must-fix. Radios stretched to 16x40 by the touch rule, and link-styled buttons were not reached.
- Round 2 (2ca1000): must-fix. `buttonVariants()` links outside settings were still 28 to 32px.
- Fix commit after round 2: `a[class~="group/button"]` added to the central touch rule, settings-only class removed. Not re-reviewed, because the cap is two fix rounds (the change is one selector).

## Findings fixed

- F-01: `app-sidebar.tsx` closes the mobile sheet on every nav, agent and New agent link.
- F-02: the menu button is portalled into the site header on phones (`shell/header-menu-slot.tsx`, slot in `header.tsx`), 40x40. The second bar is `hidden md:flex`. On phones "More" renders above the agent list.
- F-07 and the F-13 textarea part: unlayered rule in `styles.css`, input, textarea and select at 16px below md.
- F-22 and pattern 3: `[data-slot="dialog-content"]` gets `max-height: calc(100dvh - 2rem)` and scrolls. Checked at 390x664: Create routine fits, title and Close visible. Sheets are full width below 640px (the nav drawer keeps its own width).
- F-23: `@media (pointer: coarse)` rules for buttons, link buttons, icon buttons, dialog and sheet Close, select triggers, tabs, nav rows (min 40px), and an invisible 40x40 hit area for switches and checkboxes (radios already have one). Checked by switching the media rule to `all` in the browser: buttons 40px high, header icons 40x40. The browser did not report a coarse pointer, so this was not tested with real touch.
- F-25: settings nav is a horizontal scroller below md, group labels hidden. "Machines" heading no longer breaks mid-word (`[overflow-wrap:normal]` against the body's `anywhere`) and the header row wraps.

## Left alone

- The agent profile sheets were not opened in the browser: the dev database has no agents. The sheet rule is a single selector.
- Dialog height cap applies at every width and overrides a caller's own `max-h` (the three secret dialogs used `90vh`). Documented in the stylesheet.
- Alert dialogs and top or bottom sheets are not capped.

## Nits left

- The settings scroller does not scroll the active pill into view on API keys or Connected apps.
- `header-menu-slot.tsx` looks the slot up once on mount. Safe with the current routing.
- On iOS `dvh` does not shrink with the keyboard open.

## Ideas beyond scope

- Other `text-3xl` headings next to buttons will hit the same mid-word wrap, for MB.2 to MB.6.
- A sticky Close for long dialogs.

## Steps for Dom

None.
