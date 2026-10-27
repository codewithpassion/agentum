---
id: LG.0
title: Guest invitations email codes and scoped sessions
milestone: L
size: L
status: review
depends_on: [L.1]
branch: t3/guest-auth-service
lane: guest-auth
executor: codex
---

## Scope and check

Implement phase3 guest identity/grant authentication backend in isolated service module, using existing schema. Named member/guest invites, expiry/revoke, secure email OTP/session lifecycle, rate limits and switches, same-workspace access and audit events. Typed ports for email and room invalidation, no production routes or runtime enablement. Real DB/crypto/race tests. Full PRD requirements R3.1-7/R3.12-13 guide scope; later phase3 integrations stay gated on phase2.

## Log

- 2026-10-27: Sol dispatched ahead of route wiring to use independent implementation capacity. No guest execution enabled by this task.

- 2026-10-27: Merged complete backend0bb7caa7 and migration0029 after0028. Implementation25 guest tests,85 DB tests and root validation passed; independent auth review pending. Routes/runtimes and real email remain phase3 integration gates.
