---
id: LD.2
title: Shared document-schema deck rich-text codec
milestone: L
size: M
status: review
depends_on: [L.2]
branch: t3/ld2-shared-deck-codec
lane: deck-codec
executor: codex
---

## Scope and check

Implement production DOM-free RichTextCodec for packages/live-deck using the existing shared live-doc schema and Yjs representation. Strictly reject unsupported input and raw marks; preserve rich text, links, lists and table-cell text within PRD deck subset. Export a client/Worker-safe adapter and validate actual workerd execution, real Yjs rich-text round trips and hostile raw binary structures. No room, editor, services, MCP or schema migration edits. This is a leaf of phase 2, not phase completion.

## Log

- 2026-10-27: Dispatched shared rich-text integration while room/editor/guest/ask implementations proceed independently. LD.0 review findings fixed on main; all focused deck checks pass.

- 2026-10-27: Merged 5722fc90 production shared codec; 36 focused tests including workerd and implementation root check/test/build passed. Independent review pending.
