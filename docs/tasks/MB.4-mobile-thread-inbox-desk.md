---
id: MB.4
title: "Mobile: task thread, inbox, desk cards and request cards"
milestone: MB
size: M
status: done
depends_on: [MB.1]
branch: task/MB.4-mobile-thread-inbox-desk
lane: web-thread
executor: claude
---

Dom asked on 27 Oct 2026 for every function of the app to work from a phone. The audit is `docs/reviews/mobile-audit/report.md`, with screenshots in the same folder; finding ids (F-nn) below refer to it. Target phone sizes: 390x844 and 360x740. Desktop layout (md and up) must not change. Never hand-edit `apps/web/src/components/ui/` (shadcn CLI output): fix at the callers, in a shared wrapper outside `ui/`, or in the global stylesheet.

## Scope

- F-13: the task thread composer is sticky at the bottom on phones and stays above the on-screen keyboard (use `100dvh`/`visualViewport` where needed); its buttons are 40px; the send hint on touch devices says how to send (a Send button tap) instead of "⌘+Enter"; Enter behaviour stays as on desktop.
- F-15: the inbox on phones shows either the thread list or the open thread (list, then thread with a back control), the thread opens scrolled to the latest post, and the composer is sticky like the task composer.
- F-12: the task title and receipt bodies can be expanded; fact chips don't take five rows (wrap tighter or collapse); "Desk" and "Stop task" are 40px targets.
- F-03: desk card titles can be expanded or show two lines; the Done lane shows the latest few cards with "Show more"; filter chips and Approve / See changes / Reject are 40px with spacing.
- Approval and question cards (`requests/request-card.tsx` and whatever renders them in the thread and the desk) were not reachable in the audit: check them at 390x844 by creating a waiting request locally (an `ask_user` run with a choice question and a tool approval) and fix what doesn't fit.

## Check

- Each finding in scope is fixed, or the review file says why not.
- A browser check at 390x844 and 1280x800 of every screen touched (agent-browser, local dev server with dev login), screenshots in the review file.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: added from the mobile audit.
- 2026-10-27: dispatched.
- 2026-10-27: review clean after 1 fix round; merged. Task title expand not done (service truncates); keyboard offset untested on a real phone.
