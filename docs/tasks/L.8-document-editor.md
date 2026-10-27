---
id: L.8
title: Document editor and presence
milestone: L
size: L
status: in_progress
depends_on: [L.2, L.7]
branch: null
lane: web
executor: codex
---

## Scope and check

**L.8 Document editor and presence UI.** Scope: the live editor on `/a/$artifactId` for `document` artifacts, toolbar and "/" menu with the section 4 actions, case changes, tables, image upload, carets and selections, avatar stack with follow, agent status line, pending-block shimmer, agent-change underline, version history wired to checkpoints, mobile layout. Check: component tests for the toolbar actions and case changes; browser check in two profiles at 1280 x 800 and 390 x 844 for R1.15 to R1.20.

## Log

- 2026-10-27: Queued for the user-authorized implementation of all four live artifacts phases using Sol and Terra worktrees. Commit each substantial completed task. Track validation gaps explicitly.

- 2026-10-27: Starting real artifact route/provider and editor integration together with L.9 panels, separate from server L.7.
