---
id: ME.2
title: "Memory files: parse, write, budget"
milestone: ME
size: M
status: in_progress
depends_on: [ME.1]
branch: task/ME.2-memory-files-codec
lane: services-memory
executor: codex
---

From `docs/v4/build-plan.md`, milestone ME. Pure functions that read and write the memory files defined in `docs/v4/memory-format.md`.

## Scope

- `packages/services/src/memory/codec.ts`: parse a file to notes, serialise notes to a file, rebuild `index.md`. Round trip is byte-stable.
- `apply(files, change)` for add, edit, forget and merge returns the new files. Forget removes the note from the file. History stays in library versions.
- `budget(notes, maxChars)` picks notes for a prompt: corrections first, then people, places, work, newest first inside a kind.
- No database or library calls in this file.

## Check

- Tests: round trip, each action, malformed input is reported with a line number and not dropped silently, budget order.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/ME.2-memory-files-codec (v4 controller session).
