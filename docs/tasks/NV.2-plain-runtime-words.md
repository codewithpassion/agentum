---
id: NV.2
title: "Plain words for where an agent runs"
milestone: NV
size: S
status: in_progress
depends_on: []
branch: task/NV.2-plain-runtime-words
lane: web-agent
executor: claude
---

From `docs/v4/build-plan.md`, milestone NV. The Edit sheet asks for Runtime, Environment, Network access and Turn limit. A business user should pick one of three places and never see the rest.

## Scope

- In `components/agent/agent-form.tsx` and `profile/runs-on-card.tsx`, show the runtime as one choice of three: "Cloud" (`cloud`), "Anthropic cloud" (`managed`), "My computer" (`machine`). Keep the stored values.
- Move Environment (isolate or VM), Network access, Turn limit and the raw model id under one "Advanced" disclosure, closed by default. Reuse `profile/disclosure.tsx`.
- `move-agent-dialog.tsx` uses the same three names.
- The Start blank "Runs on" chips (`components/agent/builder/builder-logic.ts`) use the same three names.

## Check

- `agent-form.test.tsx` and `runs-on-card.test.tsx` cover the three labels and the closed Advanced section.
- Browser: create an agent with Start blank without opening Advanced.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/NV.2-plain-runtime-words (v4 controller session).
- 2026-11-20: scope widened to the Start blank runtime chips, which still said "Cloudflare". The task's browser check goes through Start blank, so the old word would show in its own flow.
