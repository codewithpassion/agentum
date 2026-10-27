---
id: LX.5
title: Document and deck agent suggestions
milestone: L
size: L
status: in_progress
depends_on: [L.7, LD.5, LG.2]
branch: null
lane: live-suggestions
executor: codex
---

## Scope and check

Implement R4.1: optional suggestion mode for member-triggered agent edits, and mandatory suggestions for edits from guest-triggered runs. Pending suggestions do not mutate accepted content. People with current edit authority can inspect and accept or reject individually; guarded application preserves intervening human edits, decisions are idempotent and durable, and attribution is trustworthy. Cover both documents and decks, real room/MCP/service paths and mounted UI. Coordinate the guest runtime lane and reserve migration 0032 if schema additions are necessary.

## Log

- 2026-10-28: Started after bounded extensions and guest foundations; phase4 remains incomplete pending this feature and acceptance.
