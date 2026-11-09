---
id: RT.2
title: Move an agent to another runtime
milestone: RT
size: M
status: todo
depends_on: [RT.1]
branch: null
lane: services
executor: claude
---

From the 10 Nov 2026 review. `agentUpdateSchema` forbids a runtime change (`packages/services/src/agents.ts`). Conversation context lives in the runtime, so a move starts conversations fresh.

## Scope

- A service method `changeRuntime(principal, agentId, target)`, on a browser session, for the agent's owner or an org admin.
- It refuses while any run of the agent is queued, offered, running or waiting, and names that run.
- It validates the target as create does (`validateRuntime`, `assertModelForRuntime`, `assertRuntimeConfig`): managed needs the Anthropic key and a managed model, machine needs an `agent_host` machine.
- One `atomic` write: runtime, config keys that do not apply to the target dropped, `sessions.runtimeRef` and `runtimeMachineId` cleared, the computer detached when moving to a machine. Leaving managed closes its sessions and vaults.
- A "Move agent" dialog on the Runs on card. It names the concrete blocker and its fix, and states the cost: open conversations start fresh and sandbox files do not move.
- No transcript replay.

## Check

- Service tests for each transition, the live-run refusal and each missing prerequisite.
- On staging, move a test agent from Cloudflare to managed and back and run one task each time.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
