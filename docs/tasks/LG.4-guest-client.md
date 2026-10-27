---
id: LG.4
title: Guest sign-in and scoped collaboration client
milestone: L
size: L
status: review
depends_on: [LG.3]
branch: t3/guest-client
lane: guest-client
executor: codex
---

## Scope and check

Implement phase 3 guest landing/code sign-in, artifact viewer without workspace shell, role-aware document/deck collaboration, signout/access-ended states, and member People invite controls. Use real LG.3 contracts and serialized rotating-cookie requests. Verify desktop/mobile browser flows against actual local services/room with captured email. Restricted guest agent execution remains a separate integration gate.

## Log

- 2026-10-27: Queued after merged guest backend and bounded review; all phase acceptance remains open.

- 2026-10-28: Merged implementation through ac2b8a7d and evidence62a68e46, including production-bundle desktop/mobile workerd scenarios. Independent review and combined main validation queued. Guest execution, guest embeds and external acceptance remain gates.
