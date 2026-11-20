---
id: ME.7
title: "Remember button on a message"
milestone: ME
size: S
status: done
depends_on: [ME.1]
branch: task/ME.7-remember-from-chat
lane: web-thread
executor: claude
---

From `docs/v4/build-plan.md`, milestone ME. A person can save something from a conversation without opening the Knows tab.

## Scope

- Add a Remember action to the message menu in `components/thread/`. It opens a small form with the text prefilled and a kind picker, and calls `memory.add` with the session as source.
- Show a toast with a link to the Knows tab.

## Check

- Component test for the form. Browser: remember a message, find it on the Knows tab with its source link.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/ME.7-remember-from-chat (v4 controller session).
- 2026-11-20: merged as 30cb80ea, review clean after 1 fix round. Browser proof passed at both sizes: docs/reviews/tasks/ME.7/browser.md. check and build passed on main; tests passed except guest-execution.test.ts (fails on main too, FX.1).
