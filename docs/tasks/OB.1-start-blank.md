---
id: OB.1
title: Create an agent without the builder
milestone: OB
size: S
status: done
depends_on: []
branch: task/OB.1-start-blank
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
- 2026-11-10: dispatched to a Sonnet implementer on task/OB.1-start-blank. Lane rule relaxed for this run (Dom asked for about six in parallel); files checked against the other running tasks.
- 2026-11-10: Review clean after 2 fix rounds. The dry run uses the cloud adapter for machine and Anthropic cloud agents (runs.ts hardcodes it), and the panel says so. Local check with only an OpenRouter key created a Cloudflare agent. Merged as 3c96b605. check, test and build green on main (guest-execution.test.ts failed under full-suite load and passed alone, as on main before).
