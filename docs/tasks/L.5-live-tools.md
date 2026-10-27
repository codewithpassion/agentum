---
id: L.5
title: Live document MCP tools
milestone: L
size: L
status: done
depends_on: [L.1]
branch: t3/live-document-tools
lane: mcp
executor: codex
---

## Scope and check

**L.5 Live doc MCP tools.** Scope: `packages/mcp/src/tools/live.ts` with `document_read`, `document_edit`, `document_comment`, `document_comments`; `artifact_create` accepting `document`; ports; descriptions that teach guards, pending blocks and "the person wins"; `PLATFORM_TOOL_LABELS` entries. Check: tool tests for schemas, annotations, dry-run text (R1.27) and error codes; `tools.test.ts` lists the new names.

## Log

- 2026-10-27: Queued for the user-authorized implementation of all four live artifacts phases using Sol and Terra worktrees. Commit each substantial completed task. Track validation gaps explicitly.

- 2026-10-27: Sol dispatched tool adapters against L.1 contracts, isolated from ongoing engine/service lanes.

- 2026-10-27: e24a7c51 merged, four tools/create adapter, 387 MCP tests and root suites reported passing. Independent review plus controller integration checks underway; L.7 owns actual runtime ports.

- 2026-10-27: Independent review accepted spike remediation; tool missing-find contract corrected by controller. Later runtime integration gates remain explicitly assigned to L.3/L.7.
