---
id: FR.1
title: "Agent templates"
milestone: FR
size: M
status: todo
depends_on: []
branch: null
lane: builder
executor: codex
---

From `docs/v4/build-plan.md`, milestone FR. A new workspace should start from something. `packages/services/src/agent-builder/templates.ts` exists; read it first and extend it.

## Scope

- Eight templates for small-company jobs, each a full draft the builder can show: name, job description, voice, suggested apps by catalogue key, a suggested job sentence, remember list, ask level. Examples: inbox triage, meeting follow-up, lead research, invoice filing, weekly report, support first reply, shared drive tidy, social post drafts.
- `builder.fromTemplate(key)` returns the draft through the same shape `draft.ts` returns, so the review screen needs no change.
- Templates that name catalogue keys or remember lists tolerate those features being absent.

## Check

- Tests: every template passes the builder's draft validation and creates an agent with the fake runtime.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
