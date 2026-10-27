---
id: L.Q
title: Serialize artifact quota accounting
milestone: L
size: M
status: review
depends_on: [L.1]
branch: null
lane: artifact-storage
executor: codex
---

## Scope and check

Resolve quota race from docs/reviews/tasks/L.4a.md. Static and live publications must enforce deduplicated workspace blob limits inside their atomic persistence path, with competing static/live and live/live regression tests. Avoid schema/migration changes while the live-access lane owns them; use atomic conditional accounting/assertion against existing artifact_files rows. Coordinate minimal live-service call-site integration in report.

## Log

- 2026-10-27: Sol dispatched independently of live comments/access lane.

- 2026-10-27: 2939770a merged, five race negative controls and 126 focused tests plus root suites pass. Independent atomic/D1 review follows.
