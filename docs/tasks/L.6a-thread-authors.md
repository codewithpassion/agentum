---
id: L.6a
title: Thread actor preservation and author display
milestone: L
size: M
status: in_progress
depends_on: [L.1]
branch: null
lane: thread
executor: codex
---

## Scope and check

Implement the actor-preservation portion of L.6: foldThread/applyFrame retain authenticated actor metadata and thread UI shows authors for multi-person sessions. Test streaming and replay. Do not edit services run/session logic or agent prompt; remaining L.6 follows service integration.

Use meaningful tests and required root checks. Commit substantial tasks. Follow docs/v3/live-artifacts-prd.md. Keep changes isolated from active service, document engine and MCP lanes. Do not mark the parent phase complete based on this leaf task.

## Log

- 2026-10-27: Dispatched additional independent worktree at user request to increase parallel throughput.
