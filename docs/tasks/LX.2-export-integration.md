---
id: LX.2
title: Document and deck export endpoints and download UI
milestone: L
size: L
status: review
depends_on: [LX.0, LD.5]
branch: null
lane: exports
executor: codex
---

## Scope and check

Complete R4.2 production integration of accepted export engines: authorized own-asset retrieval, document Word/PDF and deck PPTX/PDF downloads, Browser Run print adapter, endpoints and visible export actions/warnings. Verify actual archive outputs, controlled print rendering, role/access and asset isolation, limits and failures. Preserve guest isolation and existing room/editor APIs. No deployment or external browser-service usage without task evidence/authorization.

## Log

- 2026-10-27: Queued for authorized parallel implementation of remaining phase4 export integration.

- 2026-10-27: Merged98596d17 export service, member routes, Browser Run adapter and download UI;17 focused tests and leaf root tests/build passed. Combined-main validation and independent review underway; signed-in product/deployed Browser Run/quota/fidelity gates remain open.
