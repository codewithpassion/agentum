---
id: MB.8
title: "Mobile: fixes from the re-audit"
milestone: MB
size: M
status: done
depends_on: [MB.1, MB.2, MB.3, MB.4, MB.5, MB.6]
branch: task/MB.8-mobile-reaudit-fixes
lane: web-shell
executor: claude
---

The mobile re-audit after MB.1 to MB.7 is `docs/reviews/mobile-audit-2/report.md`, with screenshots in the same folder. 21 of 26 earlier findings are fixed. This task clears what is left. Desktop layout must not change except where N-01 fixes it. Never hand-edit `apps/web/src/components/ui/` (shadcn CLI output).

## Scope

- N-01 (major, desktop): no page-level sideways scroll at 1280 on `/settings/connectors`, `/settings/secrets` and `/log`; the main column must not grow to a table's width (likely `min-w-0` on the `SidebarInset` main in `routes/_app.tsx` and in `routes/_app/settings.tsx`). Check every route at 1280 and 1024 for the same.
- F-13: on the task page the composer is reachable without scrolling the whole page on a phone (sticky to the viewport bottom, or a "Reply" button that jumps to it).
- F-18: map node text readable on a phone (larger node font or minimum zoom on small screens) without breaking the desktop fit.
- N-02: inputs and native selects are 40px high on coarse pointers (global rule in the stylesheet, next to MB.1's rules).
- N-03: the small text links and controls listed in the report get a 40px hit area on coarse pointers.
- N-04: tap-to-plug and the map inspector "Remove" show a short undo toast (or a confirm); "Unassign" in the Skills sheet asks first.
- N-05: question choice buttons use at least 16px text and full-width rows on phones; "Always allow" sits apart from "Allow once".
- N-06: the settings nav scroller shows that it scrolls (fade or arrow) or wraps to two rows.
- N-07: the Links cell in the Log phone card has a label.

## Check

- Each item fixed, or the review file says why not.
- Browser check at 390x844 with touch emulation (CDP `Emulation.setTouchEmulationEnabled`, so `pointer: coarse` applies) and at 1280x800, screenshots in the review file.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: added from the mobile re-audit.
- 2026-10-27: dispatched.
- 2026-10-27: review clean after 1 fix round; merged.
