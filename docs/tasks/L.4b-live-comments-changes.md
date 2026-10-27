---
id: L.4b
title: Live comments and agent change history
milestone: L
size: M
status: done
depends_on: [L.4a]
branch: t3/live-comments-agent-changes
lane: services
executor: codex
---

## Scope and check

Extend core service with anchored comment threads, reply/resolve/answered, quota and role checks, changes list and guarded revert through room ports. Test same-workspace parent relationships and unauthorized roles.

Follow the full design in docs/v3/live-artifacts-prd.md and parent L.4 requirements. Run meaningful affected tests, root checks and build. Commit each substantive task. Keep L.4 incomplete until all slices pass integration.

## Log

- 2026-10-27: Split from incomplete L.4 implementation to keep each delegate deliverable concrete.

- 2026-10-27: Sol dispatched comments and change history against merged core factory.

- 2026-10-27: 7879f38a merged, comments/changes + atomic invalidation outbox/current admission checks. Delegate134 focused/root8106 tests plus check/build pass. Review and combined validation underway.

- 2026-10-27: Service implementation and review findings resolved, including durable dispatch/CAS audits and current source+target ask permissions independently checked in c8b54f05. Real authentication, room adapters, durable processing and release validation remain L.7/L.10 gates.
