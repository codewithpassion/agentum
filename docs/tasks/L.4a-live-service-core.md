---
id: L.4a
title: Live service core persistence and room tickets
milestone: L
size: M
status: review
depends_on: [L.1]
branch: t3/live-artifacts-service
lane: services
executor: codex
---

## Scope and check

Implement service factory and injected room/content ports, same-workspace artifact access helper, live document creation, conversion from static doc, signed room tickets, checkpoint persistence/restore and authorization invalidation. Test real DB persistence and isolated room ports. No app compose wiring.

Follow the full design in docs/v3/live-artifacts-prd.md and parent L.4 requirements. Run meaningful affected tests, root checks and build. Commit each substantive task. Keep L.4 incomplete until all slices pass integration.

## Log

- 2026-10-27: Split from incomplete L.4 implementation to keep each delegate deliverable concrete.

- 2026-10-27: Merged partial 6198644b ticket crypto helper only. Service factory/persistence remains unimplemented; Sol assigned remaining core slice. Task stays in_progress. Delegate root test was not finished at handoff; no full-suite success claimed.

- 2026-10-27: Complete core 8fdc8e70 merged, 118 affected tests and full root suite/build/check passed. Independent persistence/authorization review starts.
