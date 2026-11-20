---
id: KY.11
title: "Allowed tools for a catalogue app that has not been connected"
milestone: KY
size: S
status: todo
depends_on: [KY.7]
branch: null
lane: web-settings
executor: claude
---

From the KY walkthrough (`docs/reviews/KY-e2e.md`).

A catalogue app has `defaultAllowedTools` but no cached tool list until someone connects. The Allowed tools dialog then offers only "Clear list", so the list cannot be narrowed, and Settings, Apps shows "Tools 0" while the Keys row says "1 tool".

## Scope

Show the allowed names from the row in the dialog when the cache is empty, with remove per name, and show the catalogue's allowed count (or "not fetched yet") in the Apps table.

## Check

Component tests for the dialog with an empty cache and the table row. Browser: add Gmail from the catalogue, open Allowed tools, remove one name.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the KY walkthrough.
