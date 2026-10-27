---
id: MB.3
title: "Mobile: agent profile page and its sheets"
milestone: MB
size: M
status: done
depends_on: [MB.1]
branch: task/MB.3-mobile-agent-profile
lane: web-profile
executor: claude
---

Dom asked on 27 Oct 2026 for every function of the app to work from a phone. The audit is `docs/reviews/mobile-audit/report.md`, with screenshots in the same folder; finding ids (F-nn) below refer to it. Target phone sizes: 390x844 and 360x740. Desktop layout (md and up) must not change. Never hand-edit `apps/web/src/components/ui/` (shadcn CLI output): fix at the callers, in a shared wrapper outside `ui/`, or in the global stylesheet.

## Scope

- F-04: no page-level sideways scroll on agent profiles at 360 and 390: chips wrap or truncate with the full text reachable (for example wrap onto two lines), in `agent/profile/chip-list.tsx`, `mail-start-chip.tsx`, `profile-rows.tsx`.
- F-05: label and value stack on phones so the value gets the full width; the "Does" instruction can be expanded; library paths break at slashes, not mid-word.
- F-06 and F-10: switches, checkboxes and "+ Add" chips in the profile and the Hands to sheet are comfortable to tap (MB.1 sets the global touch-target rule; fix what it doesn't reach here). "Always" no longer wraps.
- F-08 and F-09: the profile sheets (Edit, Tools, Skills, Starts on, Hands to, Mail) work at full phone width (MB.1 makes sheets full width; check each one), the Skills version select stays inside the sheet, and Save and Archive in the Edit sheet are reachable without scrolling the whole form (for example a sticky footer).

## Check

- Each finding in scope is fixed, or the review file says why not.
- A browser check at 390x844 and 1280x800 of every screen touched (agent-browser, local dev server with dev login), screenshots in the review file.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: added from the mobile audit.
- 2026-10-27: dispatched.
- 2026-10-27: last round must-fix applied after the cap, not re-reviewed; merged, staging re-audit covers it.
