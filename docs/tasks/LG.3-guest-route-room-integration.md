---
id: LG.3
title: Guest authentication routes and artifact room access
milestone: L
size: L
status: review
depends_on: [LG.0, LG.2]
branch: t3/guest-route-room-integration
lane: guest-worker
executor: codex
---

## Scope and check

Integrate guest invitation/member lookup/email ports, scanner-safe invite and OTP/session endpoints, exact artifact-scoped read/edit/comment/thread/upload access and room admission/revocation with separate GuestGrant identity. Follow phase3 R3.1–7/R3.12–13. Supply exact typed client contracts; preserve member routes. Guest agent execution stays disabled until restricted runtime/MCP integration. Verify real services/room routes with migrated DB/workerd and email capture, expiry/revoke/switch/CSRF and cross-artifact boundaries; no real email or deployment.

## Log

- 2026-10-27: Queued for authorized parallel implementation after bounded guest auth/lifecycle and deck integration, commit substantial work.

- 2026-10-27: Merged e0d15eea. Combined root check (12 tasks plus boundary), test (12 workspace tasks plus 284 scripts), and build (5 tasks) passed. Independent review pending; guest UI and restricted guest execution remain separate gates.
