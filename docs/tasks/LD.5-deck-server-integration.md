---
id: LD.5
title: Collaborative deck room and production tool wiring
milestone: L
size: L
status: review
depends_on: [L.7, LD.0, LD.2, LD.4]
branch: null
lane: worker
executor: codex
---

## Scope and check

Implement real deck authority persistence and WebSocket transport, room presence and presenter lease enforcement, authenticated creation/checkpoints/restore, and production deck MCP adapters/registration. Reuse document production authorization and durable lifecycle boundaries. Validate actual workerd with two clients, guarded MCP edits, replay/restart, permission changes, and presenter ownership/expiry. Keep document behavior passing. Client route/provider integration and full phase acceptance remain separate.

## Log

- 2026-10-27: Started after production document wiring merged; user-authorized parallel Sol/Terra worktrees and substantial commits.

- 2026-10-27: Backend, sparse-cell authority and correlated presenter tests merged; bounded independent review found a core migration issue remediated in e2183512. Client/browser and independent remediation recheck remain open.
