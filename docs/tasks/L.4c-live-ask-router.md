---
id: L.4c
title: Artifact ask sessions router and continuation
milestone: L
size: M
status: review
depends_on: [L.4b]
branch: t3/live-ask-router
lane: services
executor: codex
---

## Scope and check

Implement shared artifact session ask with server-derived speaker envelope, authorize session create/continue/run paths, add thin liveArtifacts tRPC router with full methods and 401/403 tests. Document final L.6/L.7 ports. No compose or binding wiring.

Follow the full design in docs/v3/live-artifacts-prd.md and parent L.4 requirements. Run meaningful affected tests, root checks and build. Commit each substantive task. Keep L.4 incomplete until all slices pass integration.

## Log

- 2026-10-27: Split from incomplete L.4 implementation to keep each delegate deliverable concrete.

- 2026-10-27: Sol dispatched artifact asks/shared session router using merged L.6 envelope and L.4b service APIs.

- 2026-10-27: Merged 4aeb361b shared sessions, trusted asks, durable addressed-comment dispatch/recovery and thin router. Implementation root checks passed; independent authorization/crash-recovery review pending. Production mounting and durable processor scheduling remain L.7.
