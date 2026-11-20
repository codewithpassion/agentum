---
id: KY.2
title: "Keys read model: everything an agent may use"
milestone: KY
size: M
status: done
depends_on: [KY.1]
branch: task/KY.2-keys-read-model
lane: services-keys
executor: codex
---

From `docs/v4/build-plan.md`, milestone KY. One call returns what an agent can use and sign in to, joined from tables that four screens show today.

## Scope

- Fill `keys.forAgent`: `agent_connectors` with `credentials` (mode `user_or_agent`, `agent`, `user`, and whether the caller has their own sign-in), `agent_secrets`, `agent_mailboxes`, `slack_apps`, `a2a_connections` for the agent, `agents.hands_to`, `ask_level` and `agent_tool_rules`.
- Never return a secret value or token. Call `authorize()` first. A member sees names, an admin or the owner also sees who else has signed in.

## Check

- Service tests: each part, a member against an admin, an agent with nothing connected.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/KY.2-keys-read-model (v4 controller session).
- 2026-11-20: merged as 25885db6, review clean after 0 fix rounds. check and build passed on main. bun run test passed except guest-execution.test.ts; that test also failed alone, and failed the same way side by side on the pre-merge commit 7ba1f579, so it is not from KY.2.
