---
id: LR.2
title: Guarded document_edit ingests external Markdown images
milestone: LR
size: M
status: todo
depends_on: []
branch: null
lane: mcp
executor: claude
---

Item 2 of `docs/reviews/tasks/L.HANDOFF.md` (R1.9). Paths and the proposed boundary are in `docs/reviews/tasks/L.ACTIONS.md`. Markdown create and static conversion already fetch and store bounded external images (commits `1bc8f5d7`, `86a136d2`); reuse that code.

Today Markdown image nodes silently disappear on the guarded `document_edit` path.

## Scope
- Resolve and stage images inside the authorized, guarded, idempotent room-operation lifecycle, after guard admission. Never fetch in the MCP adapter before guard admission.
- Guard mismatch writes nothing. Input digests stay immutable. Generated IDs are stable across retries. Ownership and quota are exact. Suggestion-mode edits keep suggestion semantics. Scoped guests are refused external fetches.

## Check
- Tests for each rule in the scope, written first and failing before the change.
- The existing create/convert import tests still pass.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-28: created from L.HANDOFF.md.
