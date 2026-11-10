---
id: AB.2
title: Agent page, the few settings that matter first
milestone: AB
size: M
status: in_progress
depends_on: [AB.1, RT.1]
branch: task/AB.2-agent-page-layout
lane: web
executor: claude
---

From the 10 Nov 2026 review. Settings are split across the page, the edit sheet and Advanced.

## Scope

- Visible: Does, Tools, Starts on, owner, ask level, Runs on.
- Behind "More": Voice, Skills, Library, Channels.
- One "Works with" block for Hands to, Subagents and peers, with copy that says what each does. Say plainly that "Hands to" is a suggestion to the agent.
- Behind "Advanced": Model, Environment, Network, Turn limit, ask overrides.

## Check

- Component tests updated, screenshots before and after in the review file.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
- 2026-11-10: dispatched to a Sonnet implementer on task/AB.2-agent-page-layout. Lane rule relaxed for this run; files checked against the other running tasks. Runs beside RT.2.
