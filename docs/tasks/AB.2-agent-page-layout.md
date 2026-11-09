---
id: AB.2
title: Agent page, the few settings that matter first
milestone: AB
size: M
status: todo
depends_on: [AB.1, RT.1]
branch: null
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
