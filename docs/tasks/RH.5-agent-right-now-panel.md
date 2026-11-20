---
id: RH.5
title: "Agent room: the Right now panel"
milestone: RH
size: M
status: in_progress
depends_on: [RH.4]
branch: task/RH.5-agent-right-now-panel
lane: web-agent
executor: claude
---

From `docs/v4/build-plan.md`, milestone RH. The right side of the agent room shows live work, so a person sees what the agent is doing without opening a task.

## Scope

- Panel `components/agent/room/now/` on the Chat and Work tabs: the running task's latest step as one line (use the receipt steps from `packages/services/src/tasks/receipt.ts`), with a link to the task.
- Screen: Watch and Take over buttons when the agent has a computer, reusing `components/computer/*` and `takeover` procedures.
- Made today: files and artifacts from today's runs.
- Helpers: live subagent runs of the current task as chips with Stop, reusing the cancel run procedure, and a link to each sub-conversation.
- Learned this week: an empty slot component that ME.6 fills. Render nothing when it has no data.

## Check

- Component tests with a fixture run that has two subagents.
- Browser with the fake runtime: start a task, see the step line change, stop a helper.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: from ME.6: put Learned this week in the Right now panel by reusing LearnedList and learnedThisWeek from the Knows tab (components/agent/room/knows).
- 2026-11-20: dispatched on task/RH.5-agent-right-now-panel (v4 controller session).
