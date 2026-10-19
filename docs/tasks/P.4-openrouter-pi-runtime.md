---
id: P.4
title: OpenRouter in the Pi runtime
milestone: P
size: M
status: done
depends_on: [P.1, P.3]
branch: task/P.4-openrouter-pi-runtime
---

Asked for by Dom on 19 Oct 2026, from the report `docs/analysis/other-model-providers.md` (section D, "Changes in the Pi runtime" and "What the features need"). Inference runs in the session's Durable Object for both the isolate and the Linux VM, so one change covers both. Machines stay on Anthropic.

## Scope

- `createCloudModels` (`apps/web/src/server/pi-run-models.ts`) also registers `openrouterProvider()`. The empty auth context already keeps `OPENROUTER_API_KEY` from the Worker's environment out.
- `workspaceKeyStore` (`pi-run-credentials.ts`) answers `openrouter` from `modelKeys.resolve` and keeps answering `anthropic` from `managedKeys`. Both keys are read per request and never stored. A missing key fails the run with the OpenRouter message from P.1.
- `#modelRef` splits the prefix into `{ provider, id }` and `modelError` accepts every catalogue entry (`pi-run.ts`).
- Routing goes on each request through a wrapper around the provider's API that sets `onPayload`, the same shape as `cloudflareStreams`. The fields are `provider.quantizations` that leave out fp4, and `require_parameters: true`. No `provider.order`, so sticky routing and the prompt cache keep working. No provider pinning. Do not count on the Pi harness passing stream options through; check it.
- For a model whose `input` is text only (GLM-5.3), `inputContent` (`pi-run-files.ts`) lists image files by name and id like other files, and sends no image block.
- Add `provider` and `model` to `runs.usage`. `costUsd` stays Pi's estimate here (P.6 improves it).
- Test whether the Pi harness sends the `x-session-id` header for OpenRouter requests, and fix it if it does not, since it drives sticky routing.

## Check

- A test with a fake OpenAI-compatible server asserts `Authorization: Bearer <key>`, the model id, the routing fields (fp4 excluded, `require_parameters`, no `order`) and the `x-session-id` header. Another test shows a run with no key fails with the OpenRouter message, and one shows a text-only model gets a file list and no image block.
- A test shows an Anthropic run still reads the Anthropic key and sends no routing fields.
- Live on local dev with Dom's OpenRouter key: a GLM-5.3 agent and a DeepSeek V4.1 Flash agent each answer "Reply with the word pelican", write a file to the library and call one MCP tool, in both the isolate and the Linux VM.
- Live on staging (controller): the same pelican check on a GLM-5.3 agent and a DeepSeek V4.1 Flash agent, with the key added on the Settings page from P.2.
- `bun run check && bun run test && bun run build` pass, and the bundle grep for `drizzle` in `apps/web/dist/client` passes.

## Log
- 2026-10-19: added at Dom's request.
- 2026-10-19: dispatched.
- 2026-10-19: review clean after 0 fix rounds at 045fdb4 (docs/reviews/tasks/P.4.md). Merged. DeepSeek id deepseek/deepseek-v4.1-flash-1017 (defined in pi-run-models.ts). Isolate passed locally on both models; Linux VM leg needs staging.
