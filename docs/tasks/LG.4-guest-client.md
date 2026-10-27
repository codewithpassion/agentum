---
id: LG.4
title: Guest sign-in and scoped collaboration client
milestone: L
size: L
status: in_progress
depends_on: [LG.3]
branch: null
lane: guest-client
executor: codex
---

## Scope and check

Implement phase 3 guest landing/code sign-in, artifact viewer without workspace shell, role-aware document/deck collaboration, signout/access-ended states, and member People invite controls. Use real LG.3 contracts and serialized rotating-cookie requests. Verify desktop/mobile browser flows against actual local services/room with captured email. Restricted guest agent execution remains a separate integration gate.

## Log

- 2026-10-27: Queued after merged guest backend and bounded review; all phase acceptance remains open.
