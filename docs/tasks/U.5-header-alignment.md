---
id: U.5
title: Align the top header with the app shell
milestone: U
size: S
status: done
depends_on: [U.1]
branch: task/U.5-header-alignment
---

Reported by Dom on 17 Oct 2026 with a screenshot of `/agents`. The top header (`apps/web/src/components/header.tsx`) lays out its brand and links in `.page-wrap`, a centred fixed-width column. On signed-in pages the shell below it is full width with the sidebar on the left, so the header's "Harbourmaster" sits partway across the screen, out of line with everything under it. Dom wants the header kept and aligned, not hidden.

## Scope

On signed-in pages (the `_app` shell), the header spans the full width and its brand lines up with the sidebar's content edge. Its right-hand items line up with the right edge of the page content. The footer, if it shows there, follows the same rule. On public pages (landing, login) the header and footer stay as they are. Decide whether the sidebar's own "Harbourmaster" title still earns its place once the header brand lines up above it. If it only repeats the header, drop it, and say why in the review file. Check at desktop and mobile widths, with the sidebar open and collapsed.

## Check

Browser, dev login on a local dev server: screenshots of `/agents` at desktop (sidebar open and collapsed) and mobile widths, and of `/` and `/login` at desktop, showing the header brand lined up with the sidebar and public pages unchanged. Save them in /home/roboto/devel/harbourmaster-wt/tmp/U.5/ and list them in the review file. `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-17: added from Dom's screenshot (align, don't hide); dispatched on task/U.5-header-alignment.
- 2026-10-17: review clean after 0 fix rounds at ef49a66 (docs/reviews/tasks/U.5.md). Merged.
