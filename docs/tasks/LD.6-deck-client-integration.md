---
id: LD.6
title: Collaborative deck route and transport integration
milestone: L
size: L
status: review
depends_on: [LD.3, LD.5]
branch: null
lane: web
executor: codex
---

## Scope and check

Connect the actual deck page and editor to typed production service endpoints and the deck room protocol. Include authenticated creation/open, trusted presence, presenter lease controls, history/restore, upload ownership and deck-specific agent location metadata. Coordinate exact backend contracts with LD.5. Validate real-room two-browser collaboration at desktop/mobile, permission changes, presentation start/stop/follow and restart. Keep existing document route behavior intact. Full-app authentication/staging acceptance remains separately recorded.

## Log

- 2026-10-27: Parallel client integration started after document client review fixes merged. Backend LD.5 active; no server/service/schema ownership in this lane.

- 2026-10-27: Merged client21a5daba: actual desktop/phone workerd browser structural edits, sparse cells, peer undo and presentation lifecycle pass with original binding. Independent client review and authenticated full-app/staging acceptance remain open.
