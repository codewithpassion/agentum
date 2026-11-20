---
id: RH.13
title: "Every signed-in entry lands on home"
milestone: RH
size: S
status: done
depends_on: []
branch: task/RH.13-every-signed-in-entry-lands-on-home
lane: web-shell
executor: claude
---

From the RH gate review, round 1 (`docs/reviews/RH-1.md`, must-fix 2).

## Scope
- `apps/web/src/integrations/clerk/picker-redirect.ts`: the default target becomes `/home`, and the doc comment changes to match.
- `apps/web/src/routes/accept-invitation.tsx`: both `/desk` assignments become `/home`. Rename `GoToDesk`.
- Leave the `/assistant` redirect alone, because it opens the assistant panel on top of `/desk` on purpose. Grep `routes/` and `integrations/` for any other `"/desk"` landing.

## Check
- The picker-redirect test expects `/home` when no redirect is given.
- Browser: choose a workspace with no redirect and land on `/home`. Accept an invitation with a second dev user and land on `/home`.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the RH gate review, round 1.
- 2026-11-20: dispatched on task/RH.13-every-signed-in-entry-lands-on-home (v4 controller session).
- 2026-11-20: merged as d432071f, review clean after 1 fix round. Browser proof passed at both sizes: docs/reviews/tasks/RH.13/browser.md (invitation tested via the app redirect only). check, test and build passed on main.
