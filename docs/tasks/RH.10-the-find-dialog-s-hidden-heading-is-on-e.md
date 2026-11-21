---
id: RH.10
title: "The Find dialog's hidden heading is on every page"
milestone: RH
size: S
status: in_progress
depends_on: [RH.7]
branch: null
lane: web-shell
executor: claude
---

From the RH walkthrough (`docs/reviews/RH-e2e.md`).

The Find command dialog's screen-reader heading ("Find") is in the page while the dialog is closed, because shadcn's `CommandDialog` puts its sr-only `DialogHeader` outside `DialogContent`. A screen reader hears a stray "Find" heading on every page. The file is shadcn output, so it cannot be hand-edited.

## Scope

Build the dialog from `Dialog` and `Command` in our own wrapper outside `components/ui/`, with the title inside `DialogContent`. Low priority.

## Check

A component test that the heading is absent while closed. Browser: no "Find" heading in the page outline.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the RH walkthrough.
- 2026-11-21: dispatched.
