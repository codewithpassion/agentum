---
id: RF.1
title: Rail footer with Settings, Find and pinned Working
milestone: RF
size: M
status: in_progress
depends_on: []
branch: RF.1-rail-footer
lane: web
executor: codex
---

Spec: `docs/ux-review/rail/footer.md`, mockup `docs/ux-review/rail/footer-mockup.html`.

## Check
- Tests: footer tabs and their current state per route; three tabs for a non-admin; no Settings menu item for a non-admin; the header kbd by platform; the phone Find button opens Find; Working caps at three runs with the "View all" link and collapses on phones and short windows; the phone menu button carries the count; `/settings` redirects on desktop and lists the groups on phones.
- `bun run check && bun run test && bun run build`, then the bundle grep for `drizzle` in `apps/web/dist/client`.
- Screenshots of the result in a dev build (dev login) at 1440x900, 1440x800 and 390x844 into the log folder.

## Log
