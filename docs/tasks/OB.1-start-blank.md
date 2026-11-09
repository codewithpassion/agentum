---
id: OB.1
title: Create an agent without the builder
milestone: OB
size: S
status: todo
depends_on: []
branch: null
lane: web
executor: claude
---

From the 10 Nov 2026 review. The builder is the only way to create an agent in the UI and needs a workspace Anthropic key (`packages/services/src/agent-builder/service.ts`).

## Scope

- "Start blank" on `/agents/new`: name, what it does, runtime, then Create. It works with only a machine or only an OpenRouter key.
- The dry run uses the agent's chosen runtime where it can, and says so when it cannot.

## Check

- On staging with no Anthropic key: create a machine agent in the UI.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
