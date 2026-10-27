---
id: LX.4
title: Sandboxed deck embed elements
milestone: L
size: L
status: review
depends_on: [LD.5, LD.6]
branch: t3/deck-artifact-embeds
lane: deck-embeds
executor: codex
---

## Scope and check

Complete R4.5 deck embed elements through the existing sandboxed artifact content route. Extend constrained scene/interchange/tool/room validation and actual editor/presentation rendering, with authorized artifact-owned source files and existing sandbox protections. Preserve revision/undo/restore semantics, refuse arbitrary source URLs, and state export limitations explicitly. Verify real room/core and browser rendering/access behavior. No new schema unless coordinated.

## Log

- 2026-10-27: Dispatched for authorized parallel phase4 implementation after deck client integration.

- 2026-10-27: Merged b4c55f9f/f05ac47f; independent sandbox and ownership review queued. Leaf root and actual desktop/mobile room-browser checks passed; combined checks underway. Guest embeds and full-app acceptance remain gates.
