---
id: C.11
title: Cloud agents use their instructions; clear unknown-model error
milestone: C
size: S
status: in_progress
depends_on: [C.7]
branch: task/C.11-cloud-instructions-model
---

From C.6's and C.7's reviews (`docs/reviews/tasks/C.6.md`, `docs/reviews/tasks/C.7.md`), approved by Dom on 17 Oct 2026.

## Scope

1. Cloud agents ignore `agent.instructions`, because `PiRun` never passes them to Pi. Pass the agent's instructions to the Pi session as its system prompt (alongside whatever Harbourmaster already adds, such as skills and the attachment guidance), the way machine and managed runs use them. An edit to the instructions applies from the next run.
2. An agent with an unknown model id fails with Pi's bare `no_model`. Fail the run with a message that names the model id and lists the valid cloud models. Where the agent form lets you pick a model, it offers only valid ones.

## Check

Unit tests: the instructions reach the Pi session's system prompt, an instruction change applies on the next run, and an unknown model fails with the new message. Live on a local dev server, with `ANTHROPIC_API_KEY` from `apps/web/.env.local` stored as the workspace key in the local dev database: a cloud agent whose instructions say "Always end your reply with the word harbour" does so. `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-17: added from the C.6 and C.7 reviews (Dom: yes); dispatched on task/C.11-cloud-instructions-model.
