---
id: MB.2
title: "Mobile: tables as cards on phones, confirm before remove and revoke"
milestone: MB
size: M
status: done
depends_on: []
branch: task/MB.2-mobile-tables-confirms
lane: web-tables
executor: claude
---

Dom asked on 27 Oct 2026 for every function of the app to work from a phone. The audit is `docs/reviews/mobile-audit/report.md`, with screenshots in the same folder; finding ids (F-nn) below refer to it. Target phone sizes: 390x844 and 360x740. Desktop layout (md and up) must not change. Never hand-edit `apps/web/src/components/ui/` (shadcn CLI output): fix at the callers, in a shared wrapper outside `ui/`, or in the global stylesheet.

## Scope

- F-16, F-26 and the table parts of F-09 and F-11: on phones each table shows rows as stacked cards (or another layout where every column, and above all the row actions, is visible without sideways scrolling). Build one shared responsive-table helper outside `components/ui/` and use it in: `log/log-table.tsx`, `routines/routine-table.tsx`, `triggers/trigger-table.tsx`, `secrets/secrets-table.tsx` (and `agent/profile/sheets/secrets/secret-row.tsx`), `routes/_app/settings.api-keys.tsx`, `routes/_app/settings.machines.tsx` with `machines/machine-row.tsx`, `routes/_app/settings.connectors.tsx`, `library/library-list.tsx`, and the tables inside the agent profile sheets (`agent/profile/sheets/connectors.tsx`). Desktop keeps the table.
- Row actions on phones are at least 40px high with room between them.
- F-24: "Remove" on a routine and a trigger, and "Revoke" on an API key, ask for confirmation first (an AlertDialog naming the item), on every screen size. Look for other one-tap destructive actions in these components and give them the same confirm.

## Check

- Each finding in scope is fixed, or the review file says why not.
- A browser check at 390x844 and 1280x800 of every screen touched (agent-browser, local dev server with dev login), screenshots in the review file.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: added from the mobile audit.
- 2026-10-27: dispatched.
- 2026-10-27: review clean after 1 fix round; merged.
