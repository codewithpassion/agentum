---
id: U.8
title: Ctrl+Enter sends a chat message, Enter adds a new line
milestone: U
size: S
status: done
depends_on: []
branch: task/U.8-ctrl-enter-send
---

Asked for by Dom on 19 Oct 2026. In the chat composer, Ctrl+Enter (Cmd+Enter on macOS) sends the message, and plain Enter adds a new line.

## Scope

- Find every message composer (agent chat, and any other place a person sends a message to an agent) and apply the same rule: Ctrl+Enter or Cmd+Enter sends; Enter and Shift+Enter insert a new line. Don't send while an IME composition is active.
- Show the shortcut as a hint near the Send button ("Ctrl+Enter to send", "⌘+Enter" on macOS).
- If the composer is a shared component, change it once there.

## Check

- Component test or browser check with dev login on a local dev server: Enter adds a line, Ctrl+Enter sends, Cmd+Enter sends with a macOS user agent, the hint shows.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-19: added at Dom's request.
- 2026-10-19: dispatched.
- 2026-10-19: review clean after 0 fix rounds at 4cfa8f7 (docs/reviews/tasks/U.8.md). Merged.
