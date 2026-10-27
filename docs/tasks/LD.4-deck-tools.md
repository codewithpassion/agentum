---
id: LD.4
title: Guarded deck MCP tools and scene adapter
milestone: L
size: L
status: in_progress
depends_on: [LD.0, LD.2, L.5]
branch: null
lane: deck-tools
executor: codex
---

## Scope and check

Implement deck_read/deck_write strict MCP tools and an executable adapter over the accepted shared deck core/codec for section7 and R2.4/R2.5. Guarded HTML per-key updates must preserve human edits and surface skipped elements, with real scene tests. Export registration and typed authorized ports; production root MCP registration and real deck room/service wiring remain phase2 integration. Do not edit active L.7 runtime/server composition files or deck UI. No mock-success production ports.

## Log

- 2026-10-27: Started isolated deck tool/scene integration in parallel with document production wiring and deck editor components. Commit substantial tasks and verify focused/root checks.
