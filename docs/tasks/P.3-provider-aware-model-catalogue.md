---
id: P.3
title: Provider-aware model catalogue
milestone: P
size: S
status: in_progress
depends_on: [P.1]
branch: task/P.3-provider-aware-model-catalogue
---

Asked for by Dom on 19 Oct 2026, from the report `docs/analysis/other-model-providers.md` (section D). Dom accepted a curated list of three non-Anthropic models, all through OpenRouter. The `model` column stays one text field. A bare id or alias means Anthropic, so every existing row keeps working. Another provider is a prefix, such as `openrouter:z-ai/glm-5.3`.

## Scope

- In `packages/services/src/cloud/models.ts`, give each `CLOUD_MODELS` entry `provider`, `id`, `label`, `description` and `input` (text, or text and image). Keep the Anthropic entries as they are, with input text and image.
- Add the three entries: GLM-5.3 (`openrouter:z-ai/glm-5.3`, text), GLM-5.3 Flash (`openrouter:z-ai/glm-5.3-flash`, text and image) and DeepSeek V4.1 Flash (`openrouter:deepseek/deepseek-v4.1-flash`, text and image).
- Add parse helpers that split the prefix into `{ provider, id }`, and extend `cloudModelFor` and `cloudModelError` to accept every catalogue entry.
- Every catalogue id must exist in pi-ai 1.3.0's bundled catalogue (`providers/data/openrouter.json`), or Pi fails the run with a bare `no_model`. A unit test reads that file and checks each id. `deepseek/deepseek-v4.1-flash-1017` is not in it, so it stays out.
- The agents service refuses a prefixed model on `managed` and `machine` agents. Managed agents refuse non-Anthropic models, because `managed/config.ts:56` would otherwise run them silently on Claude.
- The agent form groups the cloud select by provider and marks a provider whose key is missing (read the key status from the P.1 service through a router call).

## Check

- Unit tests for the parse helpers and catalogue validation, including the pi-ai catalogue check above.
- An agents service test for the runtime rule: a prefixed model is valid for `cloud`, refused for `managed` and `machine`. Existing agents with bare ids still validate.
- `bun run check && bun run test && bun run build` pass, and the bundle grep for `drizzle` in `apps/web/dist/client` passes.

## Log
- 2026-10-19: added at Dom's request.
- 2026-10-19: dispatched.
