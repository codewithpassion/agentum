---
id: L.4b
title: Live comments and agent change history
milestone: L
size: M
status: todo
depends_on: [L.4a]
branch: null
lane: services
executor: codex
---

## Scope and check

Extend core service with anchored comment threads, reply/resolve/answered, quota and role checks, changes list and guarded revert through room ports. Test same-workspace parent relationships and unauthorized roles.

Follow the full design in docs/v3/live-artifacts-prd.md and parent L.4 requirements. Run meaningful affected tests, root checks and build. Commit each substantive task. Keep L.4 incomplete until all slices pass integration.

## Log

- 2026-10-27: Split from incomplete L.4 implementation to keep each delegate deliverable concrete.
