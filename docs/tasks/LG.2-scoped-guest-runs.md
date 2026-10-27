---
id: LG.2
title: Guest run charging and current scoped authorization
milestone: L
size: L
status: in_progress
depends_on: [LG.0, L.6]
branch: null
lane: services
executor: codex
---

## Scope and check

Implement atomic per-guest daily run caps and idempotent run creation/continuation, current grant and artifact-session scope checks on guest run dispatch/claim/resume and service access, and scoped approval visibility. Maintain distinct GuestGrant and Principal boundaries. Provide exact production composition and tool registration contracts; routes/runtime enablement remains gated on all scope enforcement. Test real migrated database races, revocation, expiry, workspace switch, scope bypass attempts and owner/member-only approval responses.

## Log

- 2026-10-27: Started in parallel with deck room/client integration; sole new schema writer if needed (next migration 0030), no shared app composition edits.
