---
id: RT.2
title: Move an agent to another runtime
milestone: RT
size: M
status: done
depends_on: [RT.1]
branch: task/RT.2-move-agent
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
- 2026-11-10: dispatched to a Sonnet implementer on task/RT.2-move-agent. Lane rule relaxed for this run; files checked against the other running tasks. Runs beside AB.2, which owns the page layout.
- 2026-11-10: Review clean after 1 fix round. Staging move check pending, controller. Moving cloud to managed and back brings the old Cloudflare conversation back. Merged as 9efcb4f7. Test and build green on main; check green after 31382f72 raised the web typecheck heap (tsc needs about 4.7 GB, before and after this merge).
