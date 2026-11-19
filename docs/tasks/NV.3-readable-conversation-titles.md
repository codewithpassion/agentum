---
id: NV.3
title: "Every conversation has a readable title"
milestone: NV
size: S
status: todo
depends_on: []
branch: null
lane: services-sessions
executor: codex
---

From `docs/v4/build-plan.md`, milestone NV. A run not started by mail keeps its raw input as the title, such as `{"harbourmaster_turn":{"artifact":...`. Agent cards and the Work tab will show these titles, so they must read as text.

## Scope

- Find where a session title is first set (`packages/services/src/sessions.ts`, the TH.1 backfill rule, and `mail-title-text.ts` for the mail case).
- Derive the title from the speaker envelope's text for every origin: ui, slack, trigger, qa, a2a, artifact. A routine uses its prompt's first line. Trim to one line and 80 characters.
- Never store JSON, markup or an attachment marker as a title. Fall back to "Conversation with <agent>".
- A one-off script `apps/web/scripts/retitle-sessions.ts` fixes existing rows, dry run unless `--apply`.

## Check

- `sessions.test.ts` has one case per origin and one for a JSON input.
- The script's pure helper has tests.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
