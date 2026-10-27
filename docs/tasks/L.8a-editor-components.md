---
id: L.8a
title: Rich document editor components and presence UI
milestone: L
size: L
status: review
depends_on: [L.2]
branch: null
lane: web
executor: codex
---

## Scope and check

Build L.8 rich editor components against the shared live-doc schema with injected Y.Doc/provider awareness and role. Complete section4 toolbar/slash actions, own undo, tables/case/chips/images/pending and presence/follow/mobile. Use functional tested callbacks for image persistence and checkpoint history. Do not edit route/server/compose wiring; parent L.8 integrates these after L.7. Test actual Tiptap editor actions and two editor replicas plus mobile layout.

## Log

- 2026-10-27: Sol dispatched ahead of room wiring to parallelize the web critical path. Parent L.8 stays incomplete until route integration and browser acceptance.

- 2026-10-27: Merged editor f6beacee with dependency/lock reconciliation; independent review pending.
