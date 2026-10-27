---
id: MB.1
title: "Mobile: app shell, global form sizes, dialog and sheet limits, touch targets"
milestone: MB
size: M
status: done
depends_on: []
branch: task/MB.1-mobile-shell-global
lane: web-shell
executor: claude
---

Dom asked on 27 Oct 2026 for every function of the app to work from a phone. The audit is `docs/reviews/mobile-audit/report.md`, with screenshots in the same folder; finding ids (F-nn) below refer to it. Target phone sizes: 390x844 and 360x740. Desktop layout (md and up) must not change. Never hand-edit `apps/web/src/components/ui/` (shadcn CLI output): fix at the callers, in a shared wrapper outside `ui/`, or in the global stylesheet.

## Scope

- F-01: the mobile nav sheet closes after a nav link or agent is tapped (`setOpenMobile(false)` from `useSidebar` in `components/shell/app-sidebar.tsx`).
- F-02: one header bar on mobile: the menu button moves into the header and is at least 40x40; the empty second bar goes. The "More" group (Inbox, Sessions, Log, Routines, Triggers) is reachable without scrolling past the whole agent list (for example above it, or open by default on mobile).
- F-07 and the textarea part of F-13: on small screens every input, textarea and native select is at least 16px so iOS does not zoom on focus. Prefer one rule in the global stylesheet (for example `text-base md:text-sm` on the `data-slot` selectors, or a small-screen media query) over editing nine callers.
- F-22 and pattern 3: every dialog fits a 664px-tall visible viewport: a max height of the dynamic viewport minus a margin, scrolling inside, with the title and Close visible. Sheets are full width on phones. Do this once (global stylesheet on the `data-slot` attributes, or a shared wrapper) so the Create routine dialog and the agent profile sheets are fixed by it.
- F-23: touch targets of at least 40x40 on coarse pointers for buttons, icon buttons, dialog Close, chips, switches, checkboxes and nav rows, done centrally (for example a `@media (pointer: coarse)` rule or hit-area padding), without changing the desktop look.
- F-25: on phones the settings nav is a compact control (a select or a horizontal scroller) instead of a 330px block above the content; the "Machines" heading does not wrap mid-word.

## Check

- Each finding in scope is fixed, or the review file says why not.
- A browser check at 390x844 and 1280x800 of every screen touched (agent-browser, local dev server with dev login), screenshots in the review file.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: added from the mobile audit.
- 2026-10-27: dispatched.
- 2026-10-27: review not clean after 2 rounds; the round-2 must-fix (one selector) was fixed after the cap and not re-reviewed. Controller merged it; the staging re-audit covers it.
