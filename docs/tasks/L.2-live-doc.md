---
id: L.2
title: Shared document schema and operations
milestone: L
size: L
status: review
depends_on: [L.1]
branch: t3/live-doc-collaboration
lane: doc
executor: codex
---

## Scope and check

**L.2 `packages/live-doc`.** Scope: the Tiptap extension list as the one document schema, usable in the browser and on workerd; markdown in and out; the outline projection with block ids, 8-hex hashes and revisions; the op applier for `document_edit` ops against a Y.Doc with guards, `find` targets and pending blocks; the schema sanitiser on every way in. Check: unit tests for each op and guard against `bun:sqlite`-free Y.Docs, a concurrency test of agent ops interleaved with simulated typing (R1.2, R1.24, R1.25, R1.26), and the fuzz test of R1.8.

## Log

- 2026-10-27: Queued for the user-authorized implementation of all four live artifacts phases using Sol and Terra worktrees. Commit each substantial completed task. Track validation gaps explicitly.

- 2026-10-27: Sol starts shared document engine against merged L.1 contracts; integration remains gated on contract review and full checks.

- 2026-10-27: 1bdcfb5e merged, 31 focused tests including real workerd and root checks passed. Independent engine review starts; L.3 can now implement against concrete engine API.
