---
id: ME.5
title: "Load memory and remember rules at run start"
milestone: ME
size: M
status: done
depends_on: [ME.2]
branch: task/ME.5-memory-in-prompt
lane: services-prompt
executor: claude
---

From `docs/v4/build-plan.md`, milestone ME. An agent must start each run knowing its notes. All three runtimes build the prompt from `packages/services/src/agent-prompt.ts`.

## Scope

- `agentPrompt` gains a memory section: the budgeted notes from `codec.budget`, then the remember and never lists as instructions, with one line telling the agent to use `remember` and `search_history`.
- Notes from `private/<userId>.md` load only when the run is on behalf of that user (`runs.on_behalf_of_user_id`).
- State in the prompt that notes rank below the owner's instructions.
- The caller reads the files once per run in the launch path (`runs/launch-context.ts`). Budget: 6,000 characters, a constant.

## Check

- `agent-prompt.test.ts`: section present, order, private notes only for their person, empty memory adds nothing.
- A launch test per runtime shows the section reaches the run input.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/ME.5-memory-in-prompt (v4 controller session).
- 2026-11-20: merged as ad399a7f, review clean after 1 fix round. check and build passed on main; tests passed except the two known live-artifacts flakes (room.test.ts passed alone on the merged tree; guest-execution fails on main too, FX.1). The private-notes and never-list gaps from its review became ME.10.
