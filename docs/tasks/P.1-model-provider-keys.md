---
id: P.1
title: Model provider keys service
milestone: P
size: M
status: done
depends_on: []
branch: task/P.1-model-provider-keys
---

Asked for by Dom on 19 Oct 2026, from the report `docs/analysis/other-model-providers.md` (section D). Cloud agents will run on OpenRouter models, and each workspace pays on its own OpenRouter key. The key gets its own table and service, because `managed/keys.ts` wipes Managed Agents state when the Anthropic key changes and an OpenRouter key must not do that. Copy the shape of `packages/services/src/managed/keys.ts`.

## Scope

- Add the `workspace_model_keys` schema in `packages/db`: `workspace_id`, `provider`, `api_key_enc`, `key_hint`, `set_by`, `created_at`, `updated_at`, primary key `(workspace_id, provider)`. `provider` is an enum that starts as `["openrouter"]`. Run `bun run generate` and commit `migrations/` with `migrations/meta/`.
- Add `@repo/services/model-keys` with `status`, `set`, `remove` and `resolve(workspaceId, provider)`. It encrypts with `SECRETS_KEY` and binds the ciphertext to table `workspace_model_keys`, row `<workspaceId>:<provider>` and field `api_key`.
- The shape check only needs a non-empty value under 512 characters. The live check is an injectable authenticated `GET https://openrouter.ai/api/v1/models/user`, and a 401 or 403 means a bad key. A rejected key is refused without echoing it.
- No `forgetAnthropicIds`. `set` and `remove` leave every `managed_*` row alone.
- Each provider has its own missing-key message: "This workspace has no OpenRouter API key. Add one in Settings, Model providers."
- Build the service in `composeWith` in `apps/web/src/server/compose.ts` and add it to `Services`.
- Do not use the agent secrets service. Those secrets reach the agent's environment, and a model key must never reach the agent.

## Check

- Service tests show the stored value is ciphertext bound to workspace and provider, `status` returns only the last four characters, a rejected key is refused without echoing it, `set` and `remove` leave `managed_*` rows alone, and `resolve` returns nothing for a workspace with no key.
- `bun run check && bun run test && bun run build` pass, and the bundle grep for `drizzle` in `apps/web/dist/client` passes.

## Log
- 2026-10-19: added at Dom's request.
- 2026-10-19: dispatched.
- 2026-10-19: review clean after 1 fix round at 416985c (docs/reviews/tasks/P.1.md). Merged. Migration 0007.
