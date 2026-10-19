# P.4 review

Task: OpenRouter in the Pi runtime. Branch task/P.4-openrouter-pi-runtime.

## Verdicts

- Round 1 (8c5d35f): clean, 0 must-fix, 4 nits.
- Round 2 (926a3bf, the DeepSeek id change the controller asked for): clean, 0 must-fix, 3 nits. No fix rounds.

## What changed

`createCloudModels` registers `openrouterProvider()` wrapped by `withOpenRouterRouting` (`pi-run-models.ts`). The wrapper sits on the provider's `stream` and `streamSimple`, below the Pi harness, so routing does not depend on the harness passing stream options. It merges `provider.quantizations` (every OpenRouter quantization except fp4, `unknown` kept) and `require_parameters: true` into the request body through `onPayload`, and sets no `order` or `only`. `workspaceKeyStore` takes a resolver keyed by provider: `anthropic` reads `managedKeys`, `openrouter` reads `modelKeys`, both per request, never stored. A missing OpenRouter key fails the run with the P.1 message before any request.

`#modelRef` uses `parseModelRef(cloudModelFor(model))`. `modelError` already accepted every catalogue entry after P.3. The run core hands the agent's model to `inputOf`, and `inputContent` takes `acceptsImages`: for a text-only model (GLM-5.3) image files are listed by name and id, with no image block. `usageOf` adds `provider` and `model` to `runs.usage`. `costUsd` stays Pi's estimate.

The Pi harness does send `x-session-id` (a uuidv7 per conversation, stable across submissions), and pi-ai turns it on for OpenRouter models, so no fix was needed. A test through a real `Harness` shows it.

The catalogue entry for DeepSeek moved to `deepseek/deepseek-v4.1-flash-1017` at the controller's request. pi-ai 1.3.0 does not list it, so `pi-run-models.ts` defines it from the bundled V4.1 Flash entry with the values from the OpenRouter models API on 19 Oct 2026. The API reports text and image input, so the entry keeps both (the request said text-only). `cloud-models-catalogue.test.ts` now checks the registry a run uses.

## Checks

- `bun run check && bun run test && bun run build` pass, and the `drizzle` grep on `apps/web/dist/client` finds nothing.
- Fake OpenAI-compatible server (`pi-run-models.test.ts`): bearer key, model id, routing fields, no `order`, `x-session-id` directly and through the Pi harness, and the 1017 model. Fake Anthropic server: the Anthropic key is read and the body has no routing fields. `pi-run-credentials.test.ts`: no OpenRouter key fails with the OpenRouter message and sends no request. `pi-run-files.test.ts`: text-only model gets a file list and no image block.
- Live on `vite dev` with local D1 and the OpenRouter key from `.env.local` added on the Settings page, isolate: a GLM-5.3 agent and a DeepSeek V4.1 Flash (1017) agent each answered "Reply with the word pelican" with `pelican`, then wrote a file to the library (`p4-glm.txt`, `p4-ds.txt` are in `library_entries`), called `harbourmaster_bash` over MCP and answered `pelican`. `runs.usage` holds `provider: "openrouter"` and the model id, and shows cache read tokens, so sticky routing works.
- Linux VM leg did not run locally. On this host the user container never starts under `vite dev` (`Container failed to start`, the same as C.14 recorded), and the run failed in setup before any model call.

## Nits left

1. `pi-run-models.ts` `routedOnPayload` keeps any `order` or `only` already in `params.provider`. No current catalogue model sets one.
2. `KeyProvider` in `pi-run-credentials.ts` repeats `CloudProvider` from `@repo/services/cloud/models`.
3. `pi-run-models.test.ts` never checks `x-api-key` on the Anthropic request. `pi-run-credentials.test.ts` does.
4. The `managedKeys` and `modelKeys` branches in `pi-run.ts` have no unit test (the Durable Object class cannot run under bun). The live check covers them.
5. No test covers the branch where pi-ai already lists the 1017 id, so the extra entry is skipped. The 1017 test checks `contextWindow` and `cost.input` only.
6. If a later pi-ai drops `deepseek/deepseek-v4.1-flash`, the defined 1017 entry disappears and runs fail with `no_model`. The catalogue test catches it on the bump.

## Beyond the scope

- P.6: read `usage.cost` from the response. The 1017 model costs about 6 to 10 times the old id (0.3 and 1.2 against 0.048 and 0.12 USD per million), and OpenRouter halves the rate off-peak, so Pi's estimate will drift.
- An agent saved locally with `openrouter:deepseek/deepseek-v4.1-flash` is now rejected by `cloudModelError`. Staging has no such agent, because the P.3 deploy was held until P.4.

## Steps for Dom and the controller

- Run the Linux VM leg on staging: a GLM-5.3 agent and a DeepSeek V4.1 Flash agent with `runtimeConfig.environment: linux-vm`, each answering "Reply with the word pelican", writing a file to the library and calling one MCP tool.
- The staging pelican check on both models, with the key added on the Settings page.
