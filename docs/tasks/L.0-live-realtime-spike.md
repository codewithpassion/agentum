---
id: L.0
title: Spike rooms, agent presence and conversions on workerd
milestone: L
size: M
status: done
depends_on: []
branch: t3/live-awareness-fixture-tests
lane: worker
executor: codex
---

## Scope

Complete L.0 from `docs/v3/live-artifacts-prd.md`: test hibernating Yjs rooms, server agent awareness, DOM-free markdown conversion, concurrent inserts, chunked 5 MB persistence and room ticket/revocation hooks. Record reproducible evidence and fallback decisions in `docs/v3/live-spike.md`. Keep spike code reproducible and separate from product code.

## Check

Run relevant executable checks and record actual results, distinguishing unverified staging/browser requirements. Commit substantive completed work.

## Log

- 2026-10-27: Dispatched through T3 isolated worktrees. User requested Sol and Terra in place of the repository's legacy model assignments. All four PRD phases remain in scope; commits required after substantial tasks.

- 2026-10-27: Partial spike a488f74e merged; core workerd probes pass. Completion requires two-browser coverage, verified awareness identity filtering, signed expiring ticket probes. Terra follow-up dispatched.

- 2026-10-27: Merged Terra completion 125d5583: two Chromium contexts, awareness forgery after hibernation, signed ticket replay/mismatch/expiry/tampering, read-only updates and targeted revoke passed locally. Independent review requested. Local-only issuer/signing key must not reach production; expiry/renewal and reservation recovery remain L.3 implementation requirements. Staging remains L.10 evidence.

- 2026-10-27: Independent review c7d0ce74 requests three fixes: real browser/room relative insert probe, own-client clock/reconnect regression with explicit fallback, and fail-closed local fixture deployment guard. Terra remediation dispatched; L.0 acceptance remains open.

- 2026-10-27: Merged 16dd4eee/b7014997 remediation. Browser/room relative insert and unmerged human edit converge; own-clock reconnect failure reproduced, connection-unique awareness IDs selected for L.3; local-only deployment/runtime guards verified. Root/fixture/browser checks pass in delegate. Final review pending.

- 2026-10-27: Independent review accepted spike remediation; tool missing-find contract corrected by controller. Later runtime integration gates remain explicitly assigned to L.3/L.7.
