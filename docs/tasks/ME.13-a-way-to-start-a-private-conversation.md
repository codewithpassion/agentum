---
id: ME.13
title: "A way to start a private conversation"
milestone: ME
size: S
status: done
depends_on: [ME.9]
branch: task/ME.13-a-way-to-start-a-private-conversation
lane: web-thread
executor: claude
---

From the ME walkthrough (`docs/reviews/ME-e2e.md`).

A note is private only when its session has `private = 1`, and only Slack DMs set that. In the app a person cannot start a private conversation, so a private note cannot come from the browser. The walkthrough set the flag with one `UPDATE` on the local database.

## Decision

Decision (controller, under Dom's "don't wait for me", 20 Nov 2026): add a "Private" switch when starting a conversation in the app, and show a private marker on the person's own notes on the Knows tab.

## Scope

Add a "Private" switch when starting a conversation in the app (sets the session's `private` flag), and a private marker on the person's own private notes on the Knows tab. Other members never see them.

## Check

If built: browser, start a private conversation, remember a message, see the marker on Knows, and the second member sees nothing in the Library or on Knows.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the ME walkthrough.
- 2026-11-20: dispatched on task/ME.13-a-way-to-start-a-private-conversation (v4 controller session).
- 2026-11-20: merged as 7ca2be9e, review clean after 0 fix rounds. Browser proof passed at both sizes: docs/reviews/tasks/ME.13/browser.md. check, test and build passed on main. ME complete.
