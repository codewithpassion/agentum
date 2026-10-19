---
id: P.5
title: Agent-loop trial of the catalogue
milestone: P
size: S
status: todo
depends_on: [P.4]
branch: null
---

Asked for by Dom on 19 Oct 2026, from the report `docs/analysis/other-model-providers.md` (task P.5, and the open risk about long tool loops). Nobody publishes how GLM-5.3 or DeepSeek V4.1 Flash hold up over many tool turns, so Harbourmaster measures it. This is a controller check task. The controller runs it on staging and writes the report, and needs an OpenRouter key that Dom provides (with credit on it), added on the Settings page from P.2. Without that key the task waits.

## Scope

- Script one task of at least 20 tool turns: read a skill, run a skill script, call an MCP tool, edit a library file, write an output file.
- Run it on each of the three non-Anthropic catalogue models, three times each, on staging.
- Record per run: success, turns, failed tool calls, whether the output file marker appeared, cache read share, and cost (Pi's estimate, and OpenRouter's activity page as the bill). Write the results to `docs/reviews/p5-model-trial.md`.
- Remove any model that fails two of three runs from the catalogue in `packages/services/src/cloud/models.ts`, with a small follow-up commit.

## Check

- `docs/reviews/p5-model-trial.md` exists with nine runs recorded and a keep or remove line for each model.
- Live on staging (controller): the nine runs happened against the staging Worker with Dom's OpenRouter key, and a removed model no longer shows in the agent form.
- If the catalogue changed, `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-19: added at Dom's request.
