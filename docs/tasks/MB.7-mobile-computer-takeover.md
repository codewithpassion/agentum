---
id: MB.7
title: "Mobile: computer takeover with touch and the phone keyboard"
milestone: MB
size: M
status: done
depends_on: []
branch: task/MB.7-mobile-computer-takeover
lane: computer
executor: claude
---

Dom asked on 27 Oct 2026 for every function of the app to work from a phone. The audit is `docs/reviews/mobile-audit/report.md`, with screenshots in the same folder; finding ids (F-nn) below refer to it. Target phone sizes: 390x844 and 360x740. Desktop layout (md and up) must not change. Never hand-edit `apps/web/src/components/ui/` (shadcn CLI output): fix at the callers, in a shared wrapper outside `ui/`, or in the global stylesheet.

## Scope

- F-14: the computer takeover view (`components/computer/desktop-screen.tsx`, `use-desktop-input.ts`, `desktop-input.ts`) works on a phone: tap is a left click, a two-finger drag scrolls, a long press is a right click, and one-finger drag moves the pointer with the button down (or a mode toggle between tap and drag). The screen fits the width and can be zoomed or panned.
- Typing on a phone: a visible keyboard button focuses an input of at least 16px that the phone keyboard can type into. Send text from `input`/`beforeinput` events (iOS and Android keyboards report `onKeyDown` poorly), and offer Enter, Backspace, Esc, Tab and arrow keys as buttons.
- Unit tests for the gesture-to-input mapping. The audit couldn't test a live screen; check it locally against a running computer image (`apps/computer`, the desktop variant) if you can, otherwise say so in the review file.

## Check

- Each finding in scope is fixed, or the review file says why not.
- A browser check at 390x844 and 1280x800 of every screen touched (agent-browser, local dev server with dev login), screenshots in the review file.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: added from the mobile audit.
- 2026-10-27: dispatched.
- 2026-10-27: review clean after 1 fix round; merged. Live desktop and real phone keyboard not tested (computer offline).
