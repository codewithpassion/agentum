# Other model providers for agents

Analysis for Dom, 18 Oct 2026. Read-only: no code, config or remote state was changed.

The question: can Harbourmaster agents run on non-Anthropic models such as GLM 5.3 (Z.ai) or DeepSeek V4.1 Flash, through Cloudflare Workers AI, Cloudflare AI Gateway or OpenRouter? Managed Agents stay Anthropic only and are out of scope.

## Short answer

The Cloudflare Pi runtime can do it with a small change, because the Pi library already installed (`@earendil-works/pi-ai` 1.3.0) ships providers for OpenRouter, Workers AI, AI Gateway, Z.ai and DeepSeek, with their thinking and caching quirks handled. Harbourmaster only registers the Anthropic provider and only hands Pi an Anthropic key. Inference runs in the session's Durable Object for both the isolate and the Linux VM, so both environments get the new models at once.

The recommended first route is OpenRouter direct, with one encrypted key per workspace, stored the way the Anthropic key is stored but in its own table. It has both target models, needs no Cloudflare account setup, and bills each workspace on its own key. AI Gateway can sit in front later as an add-on for logs and caching. The Workers AI binding is the cheapest to wire (no key) but bills Dom's Cloudflare account for every workspace and has no per-workspace metering, so it fits Dom's own workspace only.

Machines (Claude Code) should stay on Anthropic for now. Managed Agents stay Anthropic.

## A. How model selection works today

### The agent model field

- `agents.model` is a required text column (`packages/db/src/schema/agents.ts:17`).
- The service accepts any string of 1 to 100 characters (`packages/services/src/agents.ts:37`, used at `:104` and `:116`). It does not check the model against the runtime. Only `runtimeConfig` gets a runtime-aware check (`agents.ts:42-60`).
- Runtimes are `machine`, `managed`, `cloud` and `fake` (`packages/db/src/shared.ts:11`).

### Cloudflare Pi runtime (`runtime: "cloud"`)

- The catalogue is three Anthropic models with aliases opus, sonnet and haiku (`packages/services/src/cloud/models.ts:7-29`). `cloudModelFor` maps an alias to its id and passes anything else through (`models.ts:44-47`). `cloudModelError` rejects anything outside the catalogue (`models.ts:50-58`).
- The run core checks the model with `cloudModelError` before a run starts (`apps/web/src/server/pi-run.ts:756-760`), so a non-Anthropic id fails today.
- `#modelRef` hardcodes the provider as `anthropic` (`pi-run.ts:650-656`, constant at `:94`).
- `createCloudModels` builds Pi's model registry with an auth context that sees no env vars and no files, then registers only `anthropicProvider()` (`apps/web/src/server/pi-run-models.ts:13-23`). `setProvider` upserts by provider id (`pi-ai/dist/models.d.ts:199-201`), so more providers can be added the same way.
- `workspaceKeyStore` is the credential store. It answers only for provider id `anthropic` and returns nothing for any other id (`apps/web/src/server/pi-run-credentials.ts:19-27`). The key is read per model request and never stored in the Durable Object (`pi-run.ts:156-164`).
- The Pi harness opens in the Durable Object with that registry whether or not the session has a Linux VM (`pi-run.ts:166-204`). The VM is only the execution environment for tools. So the model choice is the same for `isolate` and `linux-vm` (`packages/services/src/cloud/environment.ts:8-25`).
- The agent form shows a select of `CLOUD_MODELS` for cloud agents and a free text box for the others (`apps/web/src/components/agent/agent-form.tsx:113`, `:154-175`).
- Usage: `usageOf` sums Pi's per-message usage, including `cost.total`, into `costUsd`, input, output and cache tokens (`apps/web/src/server/pi-run-events.ts:114-131`). `completeRun` stores it as JSON in `runs.usage` (`packages/services/src/runs.ts:925`, `packages/db/src/schema/runs.ts:62`). Pi computes `cost` from the catalogue's per-million prices, so it is an estimate, not the bill.
- Images: input image files become image blocks in the first message (`apps/web/src/server/pi-run-files.ts:158-184`). MCP tool results are flattened to text (`apps/web/src/server/pi-run-mcp.ts:417`), so connector images never reach any model today.
- Wrangler has no `ai` binding (`apps/web/wrangler.jsonc`, bindings at `:8-28`).

### What the installed Pi library supports

The package is `@earendil-works/pi-ai` 1.3.0 (`node_modules/.bun/@earendil-works+pi-ai@1.3.0+.../`), not `@mariozechner/pi-ai`. Its `dist/providers/` has factories for, among others: `anthropic`, `openrouter`, `cloudflare-workers-ai`, `cloudflare-ai-gateway`, `zai`, `zai-coding-cn`, `deepseek`, `moonshotai`, `openai`, `groq`, `together`, `fireworks`, `vercel-ai-gateway`.

- `openrouter` uses `https://openrouter.ai/api/v1`, OpenAI chat completions, key from a credential or `OPENROUTER_API_KEY`, and can refresh its catalogue and prices for the key from `GET /models/user` (`providers/openrouter.js:11-75`).
- `cloudflare-workers-ai` calls the REST endpoint `https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1` and needs a Cloudflare API token plus account id (`api/cloudflare.js:2`, `providers/cloudflare-auth.js:20-60`).
- `cloudflare-ai-gateway` calls `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/compat` (and the openai and anthropic passthroughs), authenticating with `cf-aig-authorization` (`api/cloudflare.js:6-10`, `providers/cloudflare-auth.js:62-90`).
- `api/cloudflare-ai-binding.js` adds `createAiBindingFetch(env.AI)`, which sends gateway requests through the Workers AI binding with no API token. Its comments say a request that carries its own `Authorization` header is treated as a BYOK provider key that overrides the gateway's stored keys.
- Every request takes an optional `fetch` (`dist/types.d.ts:52-57`), and the Cloudflare providers already wrap the API with `cloudflareStreams`, which rewrites options before dispatch (`providers/cloudflare-stream.js:14-20`). A wrapper that sets `fetch: createAiBindingFetch(env.AI)` has the same shape.
- `zai` points at the GLM Coding Plan endpoint `https://api.z.ai/api/coding/paas/v4` (`providers/zai.js:9`), not the pay-as-you-go API. `deepseek` points at `https://api.deepseek.com` (`providers/deepseek.js:9`).
- The OpenAI completions API handles each vendor's thinking parameter by a per-model `thinkingFormat`: `zai` (`api/openai-completions.js:623`), `deepseek` (`:670`), `openrouter` (`:682`). It adds Anthropic-style `cache_control` only for models marked `cacheControlFormat: "anthropic"` (`:798-804`). Other models rely on the vendor's automatic prefix caching.

The bundled catalogue (a models.dev snapshot taken when pi-ai 1.3.0 was built, not live data) lists these relevant entries:

| Provider in pi-ai | Model id | Context | Input | Price in/out per M (USD, snapshot) |
| --- | --- | --- | --- | --- |
| openrouter | `z-ai/glm-5.3` | 1,048,576 | text | 0.11 / 6.00 |
| openrouter | `z-ai/glm-5.3-flash` | 1,048,575 | text, image | 0.15 / 0.50 |
| openrouter | `deepseek/deepseek-v4.1-flash` | 1,048,576 | text, image | 0.006 / 0.72 |
| cloudflare-workers-ai | `@cf/zai-org/glm-5.3` | 1,048,576 | text | 1.40 / 4.40 |
| cloudflare-workers-ai | `@cf/zai-org/glm-5.3-flash` | 1,048,576 | text, image | 0.15 / 0.50 |
| cloudflare-workers-ai | `@cf/deepseek-ai/deepseek-v4-flash-0731` | 1,048,576 | text | 0.44 / 1.32 |
| zai | `glm-5.3` | 1,000,000 | text | 1.40 / 4.40 |
| deepseek | `deepseek-flash` | 1,000,000 | text, image | 0.30 / 1.20 |

The snapshot has no `deepseek-v4.1-flash` on Workers AI, only `deepseek-v4-flash-0731`. Some OpenRouter prices in the snapshot look like averaged or promotional figures. Part B has the checked facts.

### Anthropic key resolution

- `workspace_anthropic_keys` holds one encrypted key per workspace (`packages/db/src/schema/managed.ts:19-24`), encrypted with `SECRETS_KEY` and bound to workspace, table, row and field (`packages/services/src/managed/keys.ts:51-56`, `:200`).
- `set` checks the `sk-ant-` shape (`keys.ts:94-107`), optionally asks Anthropic whether the key works (`keys.ts:151-161`, wired as `validateAnthropicKey` in `apps/web/src/server/compose.ts:163-164`, `:340-345`), and in the same atomic write deletes the workspace's managed sessions, agents and skills (`keys.ts:163-173`, `:203-226`). `remove` does the same delete (`keys.ts:231-243`).
- `resolve(workspaceId)` decrypts it for a runtime (`keys.ts:246-266`).
- `NO_KEY_MESSAGE` names the Settings section "Anthropic API key" (`keys.ts:39-40`). Both the cloud and managed runtimes use it (`pi-run-credentials.ts:25`).

That forced wipe of Anthropic-side ids is why a second provider key must not live in this table or go through this service.

### Managed Agents

`modelFor` maps an alias or a known Anthropic id and falls back to the default model for anything else (`packages/services/src/managed/config.ts:50-57`). So a GLM id on a managed agent would silently run on Claude. The form should keep non-Anthropic models away from managed agents.

### Machines (daemon running Claude Code)

- The daemon passes `claim.agent.model` straight to the Agent SDK `model` option (`apps/daemon/src/executor.ts:308`).
- The child's environment is filtered: only `CLAUDE_CONFIG_DIR`, `HOME`, `PATH` and a few others pass (`apps/daemon/src/agent-env.ts:9-28`), and any name matching `TOKEN|KEY|SECRET|...` is dropped (`agent-env.ts:44`). `ANTHROPIC_BASE_URL` is not on the allow list. Agent secrets are added after the filter (`executor.ts:305-307`), but the secrets service reserves the `ANTHROPIC_` and `CLAUDE` prefixes (`packages/services/src/secrets.ts:85-88`).
- `settingSources: ["project"]` (`executor.ts:311`) means user-level Claude Code settings, where an `env` block could set a base URL, are not read.
- The child signs in with the machine's Claude subscription, and no API key passes (`agent-env.ts:1-3`).

So today a machine agent cannot be pointed at another endpoint without a code change. The mechanism, if wanted, would be: the claim carries a base URL and token for the agent, and the daemon writes them as `env.ANTHROPIC_BASE_URL` and `env.ANTHROPIC_AUTH_TOKEN` into the work dir's `.claude/settings.json` (a project setting, so it is read).

Is it wise? Not as a default. Claude Code is built and tested against Anthropic's Messages API: its tool schemas, `cache_control` blocks, thinking blocks and model-specific prompts assume Claude. Anthropic-compatible endpoints from OpenRouter, Z.ai or DeepSeek (see part B) are translation layers. They work for simple use, but long agent loops hit gaps such as dropped thinking blocks, different tool-call streaming, no prompt caching through the shim, and Claude Code features keyed to model names. It also moves billing off the machine's subscription onto a token Harbourmaster would have to deliver to a user's machine. Treat it as an experiment for Dom's own machine, not a product feature.

## B. Current facts from the web

Checked on 18 Oct 2026 against vendor docs and the live OpenRouter model list. Benchmarks are the vendors' own unless stated.

### The two models

GLM-5.3 exists. Z.ai released it around 14 Aug 2026, first on the GLM Coding Plan, and OpenRouter added it on 18 Aug. It has a 1M context, 128K max output, text-only input and function calling. Reasoning is always on: `reasoning_effort` takes low, high or max, and cannot be switched off. Z.ai's price is $1.40 input, $0.26 cached input and $4.40 output per million tokens. GLM-5.3-Flash is the cheap sibling at $0.15 / $0.03 / $0.50, and it takes images. Z.ai reports big agentic gains over GLM-5.2 (DeepSWE 66.9 against 46.2, Terminal-Bench 3.0 28.3 against 4.6). I found no independent results. Sources: https://docs.z.ai/guides/llm/glm-5.3, https://docs.z.ai/guides/overview/pricing.

DeepSeek V4.1 Flash exists. It launched on 10 Sep 2026. DeepSeek's API id is `deepseek-flash`, now served by `DeepSeek-V4.1-Flash-1017`. It has a 1M context, 384K max output, tool calls, vision, and thinking on by default. DeepSeek's own price, off-peak / peak per million tokens, is $0.003 / $0.006 for cache hits, $0.15 / $0.30 for cache misses and $0.60 / $1.20 output. Peak is 01:00 to 04:00 and 06:00 to 10:00 UTC on weekdays. DeepSeek reports DeepSWE 74.2. Independent results are mixed, with weak scores on an SRE benchmark and a legal agent benchmark (https://www.deeplearning.ai/the-batch/deepseek-pushes-the-frontier-again-deepseek-refreshed-its-v4-flash-model-with-an-impressive-fine-tune). Pricing: https://api-docs.deepseek.com/quick_start/pricing.

### Where each model is offered

| Route | GLM-5.3 | DeepSeek V4.1 Flash |
| --- | --- | --- |
| Workers AI | `@cf/zai-org/glm-5.3`, function calling, 1,048,576 context, $1.40 / $0.26 / $4.40 | Not offered. Newest is `@cf/deepseek-ai/deepseek-v4-flash-0731` (V4 Flash, not V4.1), function calling, 1,048,576 context, $0.44 / $0.014 / $1.32 |
| AI Gateway | Through Workers AI, or through OpenRouter passthrough with an OpenRouter key | Through the DeepSeek or OpenRouter passthrough with that provider's key |
| OpenRouter | `z-ai/glm-5.3`, tools, 1,048,576 context | `deepseek/deepseek-v4.1-flash` and `deepseek/deepseek-v4.1-flash-1017`, tools, 1,048,576 context |

Workers AI notes (https://developers.cloudflare.com/workers-ai/models/, https://developers.cloudflare.com/changelog/post/2026-08-07-workers-ai-unified-billing/). The GLM-5.x, DeepSeek V4 and Kimi K2.6/K2.7 models need Workers Paid or prepaid credits. Frontier models are limited to 20 requests a minute on standard billing and 50 with credits. That limit matters: one agent loop makes a request per turn, so a few busy agents in one account would queue. The OpenAI-compatible endpoint is `https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1/chat/completions`, and the model pages list function calling. Other function-calling models there: `@cf/moonshotai/kimi-k2.7-code`, `@cf/moonshotai/kimi-k2.6`, `@cf/openai/gpt-oss-120b`, `@cf/qwen/qwen3.8-27b`, `@cf/nvidia/nemotron-3-120b-a12b`, `@cf/meta/llama-4-scout-17b-16e-instruct`.

AI Gateway notes.
- The `/compat` endpoint (`https://gateway.ai.cloudflare.com/v1/{acct}/{gw}/compat/chat/completions`, model as `provider/model`) still works but is now marked deprecated for single-model calls. Its provider list has Workers AI and DeepSeek but not OpenRouter or Z.ai (https://developers.cloudflare.com/ai-gateway/usage/chat-completion/).
- Cloudflare now points new code to a REST API at `https://api.cloudflare.com/client/v4/accounts/{acct}/ai/` with `run`, `v1/chat/completions`, `v1/responses` and `v1/messages`, a gateway picked with the `cf-aig-gateway-id` header (https://developers.cloudflare.com/ai-gateway/usage/rest-api/). The page does not document tool calling for third-party models.
- Provider passthrough exists for 24 providers, including `openrouter` and `deepseek`, but not Z.ai (https://developers.cloudflare.com/ai-gateway/usage/providers/).
- Unified billing covers OpenAI, Anthropic, Google, Vertex, xAI, Groq and Workers AI, with a 5% fee on credit purchases. It does not list DeepSeek or OpenRouter (https://developers.cloudflare.com/ai-gateway/features/unified-billing/).
- BYOK keys live in Secrets Store. A request's own `Authorization` header is forwarded and wins over BYOK and unified billing, so a per-workspace key can pass through the gateway (https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/).
- Caching is off by default and only matches identical requests, which an agent loop rarely sends twice. Logging and cost analytics come with every gateway. With DLP response scanning on, the gateway buffers a whole streamed response.

OpenRouter notes.
- The headline price on a model is the cheapest provider, often an fp4 quantisation. `z-ai/glm-5.3` headlines at $0.079 input from an fp4 provider, while Z.ai and Cloudflare serve it at $1.40 / $4.40. DeepSeek serves V4.1 Flash at $0.15 / $0.60. Pin providers with `provider.order`, `only` or `quantizations`.
- Requests that carry `tools` go only to providers that support tools. `require_parameters: true` also skips providers missing any other requested parameter (https://openrouter.ai/docs/guides/routing/provider-selection).
- Prompt caching is automatic for DeepSeek (cache reads at about 0.1x input) and Z.ai (about 0.2x). Sticky routing to the same provider uses the session id, expires after 10 minutes and is skipped when `provider.order` is set (https://openrouter.ai/docs/guides/best-practices/prompt-caching).
- Every response now carries `usage.cost` and cached token counts, in the last chunk when streaming (https://openrouter.ai/docs/guides/administration/usage-accounting).
- OpenRouter has an Anthropic-compatible endpoint for Claude Code (`ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN`, empty `ANTHROPIC_API_KEY`), and says it guarantees compatibility only for Anthropic models (https://openrouter.ai/docs/guides/guides/claude-code-integration).

Anthropic-compatible endpoints of the vendors.
- Z.ai: `https://api.z.ai/api/anthropic`, documented as part of the GLM Coding Plan (https://docs.z.ai/scenario-example/develop-tools/claude). Pay-as-you-go OpenAI-format calls go to `https://api.z.ai/api/paas/v4/`.
- DeepSeek: `https://api.deepseek.com/anthropic` (https://api-docs.deepseek.com/guides/anthropic_api). It maps `claude-opus*` to V4 Pro and every other `claude*` name to `deepseek-flash`, and returns 400 for other names. It supports tools, thinking and images. It ignores `cache_control`, `mcp_servers` and `is_error`, and does not support `document`, `redacted_thinking` or MCP tool blocks.

### Could not confirm

- Whether Z.ai's Anthropic endpoint takes pay-as-you-go keys or only Coding Plan keys.
- Whether DeepSeek routes V4 Pro requests to V4.1 Flash. A news report says so, but the pricing page still lists V4-Pro-0813.
- How well GLM or DeepSeek behave behind OpenRouter's Anthropic endpoint.
- Tool calling and streaming for third-party models through AI Gateway's REST `/ai/v1/chat/completions`. The docs say nothing either way.
- Whether unified billing covers DeepSeek or OpenRouter. They are missing from the provider list, yet `deepseek/deepseek-v4-pro` appears in the gateway catalogue.
- Any independent benchmark for GLM-5.3.
- Whether OpenRouter's sticky routing survives `provider.quantizations` or `require_parameters`. Only `provider.order` is documented to turn it off.
- OpenRouter's key prefix. The design leans on the live check, not a prefix.
- How either model holds up over 50 or more tool turns. Nobody publishes that, and Harbourmaster has to measure it (task P.5).

## C. The three routes compared

What matters for Harbourmaster is tool calling over long loops: dozens of turns with MCP tools, library file tools, skill scripts and, in the VM, a shell. Price and catalogue size come second.

| | Workers AI binding | AI Gateway | OpenRouter direct |
| --- | --- | --- | --- |
| GLM-5.3 | Yes | Yes, through Workers AI or OpenRouter | Yes |
| DeepSeek V4.1 Flash | No, V4 Flash 0731 only | Through OpenRouter or DeepSeek passthrough | Yes |
| Key | None with the binding. Pi's built-in provider uses REST and wants a Cloudflare API token and account id | Gateway auth token, plus a provider key (stored BYOK, or per request) | One OpenRouter key per workspace |
| Who pays | Dom's Cloudflare account, for every workspace | Dom's account (unified billing, BYOK) or the workspace (per-request key) | The workspace |
| Per-workspace metering | None today | Gateway logs can carry metadata, nothing in Harbourmaster reads them | Built in, each key is its own bill |
| Rate limit | 20 req/min per frontier model on standard billing, 50 with credits | 200 req/min on managed credentials, BYOK exempt | Per key and credit balance |
| Pi support | `cloudflare-workers-ai` provider (REST). The binding needs a small wrapper with `createAiBindingFetch` | `cloudflare-ai-gateway` provider, but it targets the deprecated `/compat` URL | `openrouter` provider, with thinking and session affinity set per model |
| Logs and caching | Workers AI dashboard | Yes. Exact-match caching seldom hits in agent loops | OpenRouter activity page and `usage.cost` per response |
| Config to add | `ai` binding in three places in `wrangler.jsonc` | Account id, gateway id, gateway token | None |

Tool-call quality. GLM-5.3, GLM-5.3-Flash, DeepSeek V4.1 Flash, Kimi K2.6/K2.7 and gpt-oss-120b all advertise function calling, and GLM-5.3 and DeepSeek V4.1 Flash are pitched as agentic models. Treat these as weak for long loops until tested: `@cf/meta/llama-4-scout-17b-16e-instruct`, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (24K context in pi-ai's catalogue), `@cf/qwen/qwen3-30b-a3b-fp8` (32K context), `@cf/ibm-granite/granite-4.0-h-micro` and `@cf/mistralai/mistral-small-3.1-24b-instruct`. Their contexts are too small for an agent with skills and MCP tool lists, or their tool use is known to be shaky. On OpenRouter, the fp4 providers that win on headline price are the main tool-call risk, because quantisation hurts structured output first.

My read. Workers AI is the neatest fit for the platform, since there is no key and it is the same account. But it has no DeepSeek V4.1 Flash, the per-model rate limit would bite as soon as two or three agents run at once, and it puts every workspace's spend on Dom's bill with nothing to meter it. AI Gateway adds logs and caching but no models of its own, and its OpenAI-compatible endpoint is in flux right now (`/compat` deprecated, REST API new and thin on tool-call docs). OpenRouter has both models today, Pi already speaks it, and the per-workspace key copies a pattern Harbourmaster already has. Its weak spot is provider routing, which one request field fixes.

## D. Recommended design

### Route

OpenRouter direct, one key per workspace. AI Gateway and Workers AI come later as optional tasks, and neither blocks the first version.

### Where the key lives

Add a new table, `workspace_model_keys`: `workspace_id`, `provider`, `api_key_enc`, `key_hint`, `set_by`, `created_at`, `updated_at`, with primary key `(workspace_id, provider)`. `provider` is an enum that starts as `["openrouter"]`. A new service, `@repo/services/model-keys`, copies `managed/keys.ts` (`status`, `set`, `remove`, `resolve`) with these differences:

- It has no `forgetAnthropicIds`. Changing an OpenRouter key must not wipe Managed Agents state.
- The live check carries the validation. The shape check only needs a non-empty value under 512 characters, unless P.1 confirms OpenRouter's key prefix on its key page. The live check is an authenticated `GET https://openrouter.ai/api/v1/models/user`, the same call pi-ai makes (`providers/openrouter.js:22-26`). A 401 or 403 means a bad key.
- It encrypts with `SECRETS_KEY` and binds the ciphertext to table `workspace_model_keys`, row `<workspaceId>:<provider>` and field `api_key`.
- Each provider gets its own missing-key message: "This workspace has no OpenRouter API key. Add one in Settings, Model providers."

Do not use the agent secrets service for this. Those secrets are granted per agent and land in the agent's environment, and a model key must never reach the agent.

Settings gets a "Model providers" page next to "Anthropic API key", with the same paste, hint and remove flow.

### How an agent picks a provider and model

Keep the one `model` column. A bare id or alias means Anthropic, so every existing row keeps working. Another provider is a prefix, `openrouter:z-ai/glm-5.3`, which fits the 100-character limit. `CLOUD_MODELS` becomes a curated catalogue with `provider`, `id`, `label`, `description` and `input` (text, or text and image) for each entry. The first set:

| Label | Stored model | Input |
| --- | --- | --- |
| Opus 5.5, Sonnet 5.5, Haiku 5.5 | unchanged | text, image |
| GLM-5.3 (OpenRouter) | `openrouter:z-ai/glm-5.3` | text |
| GLM-5.3 Flash (OpenRouter) | `openrouter:z-ai/glm-5.3-flash` | text, image |
| DeepSeek V4.1 Flash (OpenRouter) | `openrouter:deepseek/deepseek-v4.1-flash` | text, image |

The form groups the cloud select by provider and marks a provider whose key is missing. The agents service checks the model against the runtime. A prefixed model is valid only for `cloud` agents. On a managed agent it would otherwise run silently on Claude (`managed/config.ts:56`), and on a machine Claude Code would reject it.

### Runtime support

| Runtime | Other models | Why |
| --- | --- | --- |
| Cloudflare Pi, isolate | Yes | Pi runs in the Durable Object and pi-ai has the provider |
| Cloudflare Pi, Linux VM | Yes | Same harness. The VM only runs tools |
| Machines | No, for now | Claude Code with the machine's Claude login. Needs base URL plumbing and a key on the user's machine, and third-party Anthropic shims are unsupported for non-Claude models |
| Managed Agents | No | Anthropic only |

### Changes in the Pi runtime

- `createCloudModels` also registers `openrouterProvider()` (`pi-run-models.ts:21`). The empty auth context already keeps `OPENROUTER_API_KEY` from the Worker's environment out.
- `workspaceKeyStore` answers `openrouter` from `modelKeys.resolve(workspaceId, "openrouter")` and keeps answering `anthropic` from `managedKeys` (`pi-run-credentials.ts:19-27`). Both keys are read for each request and never stored.
- `#modelRef` splits the prefix into `{ provider, id }` (`pi-run.ts:650-656`), and `modelError` accepts every catalogue entry (`pi-run.ts:756-760`).
- OpenRouter routing goes on each request through a wrapper around the provider's API that sets `onPayload` in the request options, the same wrapper shape as `cloudflareStreams` (`providers/cloudflare-stream.js:14-20`). The API applies `onPayload` at `api/openai-completions.js:188`. Nothing shows that the Pi harness passes stream options through itself, so do not count on it. The routing fields are `provider.quantizations` that leave out fp4, and `require_parameters: true`. Leave out `provider.order`, because it turns off sticky routing and with it the prompt cache.
- Image input. For a model whose `input` is text only (GLM-5.3), `inputContent` lists image files by name and id, the way it lists other files, rather than sending image blocks (`pi-run-files.ts:158-184`).

### What the features need

- Tools, skills and MCP. Pi sends every tool as an OpenAI function, so MCP tools, library tools, `run_skill_script` and the VM shell work on any model with function calling. Skills are text in the system prompt and tool results, so nothing changes. Quality over long loops is the open risk, and P.5 measures it.
- Prompt caching. Anthropic models keep explicit `cache_control`. GLM and DeepSeek on OpenRouter cache prefixes on their own, and pi-ai sends OpenRouter's `x-session-id` header when the request has a session id, and turns that on for any OpenRouter base URL (`openai-completions.js:544-546`, `:1299-1300`). Whether the Pi harness supplies a session id is not checked, so P.4 tests for the header. With 1M-context models in long loops, uncached input is the main cost risk, so P.5 should log cache read tokens.
- Attachments and images. Input images go only to image-capable models, as above. MCP tool images are text today on every model (`pi-run-mcp.ts:417`), so nothing changes there.
- Thinking. pi-ai sets each vendor's reasoning parameter from the model's `thinkingFormat` (`openai-completions.js:623`, `:670`, `:682`). GLM-5.3 always reasons, so expect more output tokens per turn than its price suggests. Keep Pi's default level and do not expose a setting until someone asks for one.
- Output files and `[ATTACHMENT:path]` markers are plain text conventions in the instructions, so they work unchanged. A weaker model may forget them, which P.5 will show.

### Cost and usage logging

`runs.usage` already takes extra fields (`packages/services/src/runs/types.ts:72-76`, a loose object). Add `provider` and `model` to it, so the Log page and any later report can split spend by model. `costUsd` stays Pi's estimate from the catalogue, because pi-ai does not read OpenRouter's `usage.cost`. That estimate goes stale as prices change, and OpenRouter's real cost depends on which provider served the request. A small follow-up can read `usage.cost` from the response (through `onResponse` or the final chunk) and store it as `costUsd` when present. OpenRouter's own activity page remains the bill.

### Tasks

The milestone is P. File format follows `docs/tasks/C.6-cloud-model-key.md`.

**P.1 Model provider keys service** (M, depends on nothing). Add the `workspace_model_keys` schema and migration, and `@repo/services/model-keys` with `status`, `set`, `remove` and `resolve`, the OpenRouter shape check and an injectable live check. Wire it in `compose.ts`. Check: tests show the stored value is ciphertext bound to workspace and provider, `status` returns only the last four characters, a rejected key is refused without echoing it, and `set` leaves `managed_*` rows alone. `bun run check && bun run test && bun run build` and the bundle grep pass.

**P.2 Settings page for model providers** (S, depends on P.1). Add a tRPC router and a "Model providers" Settings page with paste, hint and remove for the OpenRouter key. Check: in the browser with dev login, add a key, see its hint, remove it. No key appears in network responses or logs.

**P.3 Provider-aware model catalogue** (S, depends on nothing). Add `provider` and `input` to `CLOUD_MODELS`, the prefix encoding, parse helpers and catalogue validation. The agents service refuses a prefixed model on `managed` and `machine` agents. The form groups by provider and flags a missing key. Every catalogue id must exist in pi-ai 1.3.0's bundled catalogue (`providers/data/openrouter.json`), or Pi fails the run with a bare `no_model`, as C.6 noted. The three proposed ids are there. `deepseek/deepseek-v4.1-flash-1017` is not. Check: unit tests for parse and validation, and an agents service test for the runtime rule. Existing agents with bare ids still validate.

**P.4 OpenRouter in the Pi runtime** (M, depends on P.1, P.3). Register the provider, extend the credential store, `#modelRef` and `modelError`, add the routing `onPayload`, the text-only image fallback and `provider` and `model` in usage. Check: a test with a fake OpenAI-compatible server asserts `Authorization: Bearer <key>`, the model id, the routing fields and the `x-session-id` header, and that a run with no key fails with the OpenRouter message. Live on local dev with Dom's OpenRouter key: a GLM-5.3 agent and a DeepSeek V4.1 Flash agent each answer "Reply with the word pelican", write a file to the library and call one MCP tool, in both the isolate and the Linux VM.

**P.5 Agent-loop trial of the catalogue** (S, depends on P.4). Run one scripted task of at least 20 tool turns (skill read, skill script, MCP call, library edit, output file) on each catalogue model, three times each. Record success, turns, failed tool calls, cache read share and cost in `docs/reviews/`. Check: the report exists, and any model that fails two of three runs comes out of the catalogue.

**P.6 Real cost from OpenRouter** (S, depends on P.4, optional). Store OpenRouter's `usage.cost` as `costUsd` when the response carries it. Check: the fake-server test returns a `usage.cost` and the run's usage holds it.

**P.7 AI Gateway in front of OpenRouter** (S, later, optional). Point the OpenRouter provider's base URL at the gateway's `openrouter` passthrough when `AI_GATEWAY_ACCOUNT_ID` and `AI_GATEWAY_ID` are set. The workspace key travels in `Authorization`, so it overrides any stored BYOK key. Check: a live request shows in the gateway log with the run id as metadata, and tool calls still stream.

**P.8 Workers AI for one workspace** (M, later, optional, only if Dom wants Cloudflare-billed models). Add an `ai` binding at top level, `env.staging` and `env.staging.previews`. Add a provider that wraps pi-ai's Workers AI models with a `fetch` through the binding, using the same wrapper shape as `cloudflareStreams` (`providers/cloudflare-stream.js:14-20`), and allow it only for workspaces on a list. Check: live, a `workers-ai:@cf/zai-org/glm-5.3` agent passes the P.4 checks, and a workspace not on the list is refused.

Not proposed: machines on other models. If Dom wants it later, the shape is a claim field with base URL and token, written by the daemon into the work dir's `.claude/settings.json`.

### Open decisions for Dom

Dom accepted all the defaults below on 19 Oct 2026. The P tasks cover them as P.1 to P.6. P.7 (AI Gateway) and P.8 (Workers AI) are not in this milestone and have no task files.

1. Who holds the key and pays. Default: each workspace adds its own OpenRouter key and pays OpenRouter. The alternative, Cloudflare billing on Dom's account, needs quotas and metering first.
2. Curated list or any OpenRouter id. Default: the curated list above, three non-Anthropic models. More can come after they pass P.5. Any id would need a runtime catalogue refresh (pi-ai's `personalizeOpenRouterCatalog` or `fetchModels`), because Pi only knows the ids bundled in its release. A model that appears on OpenRouter tomorrow is not selectable until pi-ai ships it or Harbourmaster adds that refresh.
3. OpenRouter routing. Default: leave out fp4 providers and set `require_parameters: true`, with no fixed provider order, so caching keeps working. The alternative is to pin first-party providers (Z.ai, DeepSeek): better quality, higher price, no sticky cache.
4. Images for text-only models. Default: list the file by name and send no image block, so GLM-5.3 runs never fail on an image.
5. AI Gateway. Default: later (P.7), after OpenRouter works, and only if Dom wants the logs.
6. Workers AI. Default: not now. Its DeepSeek is V4 Flash, not V4.1, every workspace's spend lands on Dom's bill, and frontier models allow 20 requests a minute.
7. Machines. Default: stay on Claude Code with Anthropic models. Revisit only as an experiment on Dom's own machine.
8. Z.ai and DeepSeek direct keys. Default: not offered. OpenRouter reaches both, and pi-ai's `zai` provider targets the Coding Plan endpoint, not pay-as-you-go.
9. Cost figure. Default: P.6, store OpenRouter's reported cost when present, and fall back to Pi's catalogue estimate.
