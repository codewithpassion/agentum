---
id: L.2
title: Shared document schema and operations
milestone: L
size: L
status: todo
depends_on: [L.1]
branch: null
lane: doc
executor: codex
---

## Scope and check

**L.2 `packages/live-doc`.** Scope: the Tiptap extension list as the one document schema, usable in the browser and on workerd; markdown in and out; the outline projection with block ids, 8-hex hashes and revisions; the op applier for `document_edit` ops against a Y.Doc with guards, `find` targets and pending blocks; the schema sanitiser on every way in. Check: unit tests for each op and guard against `bun:sqlite`-free Y.Docs, a concurrency test of agent ops interleaved with simulated typing (R1.2, R1.24, R1.25, R1.26), and the fuzz test of R1.8.

## Log

- 2026-10-27: Queued for the user-authorized implementation of all four live artifacts phases using Sol and Terra worktrees. Commit each substantial completed task. Track validation gaps explicitly.
