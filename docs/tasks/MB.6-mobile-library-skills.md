---
id: MB.6
title: "Mobile: library file panel and skills index"
milestone: MB
size: S
status: done
depends_on: [MB.1]
branch: task/MB.6-mobile-library-skills
lane: web-library
executor: claude
---

Dom asked on 27 Oct 2026 for every function of the app to work from a phone. The audit is `docs/reviews/mobile-audit/report.md`, with screenshots in the same folder; finding ids (F-nn) below refer to it. Target phone sizes: 390x844 and 360x740. Desktop layout (md and up) must not change. Never hand-edit `apps/web/src/components/ui/` (shadcn CLI output): fix at the callers, in a shared wrapper outside `ui/`, or in the global stylesheet.

## Scope

- F-17: tapping a file in the library on a phone shows the file panel at once (a full-screen view or sheet with a back control, or scroll into view), and rows are 40px targets.
- F-21: on phones the skills list comes first; the new skill, upload and GitHub import forms sit behind one "Add skill" control (dialog or collapsible). Skill rows are 40px.
- The library history panel and wiki page view weren't reachable in the audit: create a wiki page locally and check both at 390x844, fixing what doesn't fit.

## Check

- Each finding in scope is fixed, or the review file says why not.
- A browser check at 390x844 and 1280x800 of every screen touched (agent-browser, local dev server with dev login), screenshots in the review file.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: added from the mobile audit.
- 2026-10-27: dispatched.
- 2026-10-27: review clean after 0 fix rounds; merged.
