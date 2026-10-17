# C.6 review

Task: Workspace model key for cloud agents. Branch task/C.6-cloud-model-key.

## Verdicts

- Round 1 (46b7b7d): clean, 0 must-fix, 5 nits. No fix rounds.

The reviewer traced the key through pi-ai 1.3.0 and found no path where it is stored, logged or replaced by the Worker's own `ANTHROPIC_API_KEY`. The reviewer also ran the new tests and the bundle grep.

## What changed

`PiRun` builds its Pi models with `createCloudModels` (`pi-run-models.ts`) over a read-only `CredentialStore`, `workspaceKeyStore` (`pi-run-credentials.ts`). Each model request calls the store, which reads the workspace id from Durable Object storage and asks `managedKeys.resolve` (the M8.1 secrets store) for the decrypted key. Nothing keeps the key: it is not in Durable Object storage and not in a field, and a rotated key applies to the next request. `startRun` saves the workspace id, which is not a secret.

A workspace with no key fails the run with "This workspace has no Anthropic API key. Add one in Settings, Managed Agents." The auth context reports no env vars and no files, so an `ANTHROPIC_API_KEY` in the Worker's environment is never a fallback. This matters locally, where `.env.local` puts that variable in the Worker's environment.

The model list is `@repo/services/cloud/models`: `CLOUD_MODELS` (opus, sonnet, haiku with their 5.5 ids), `CLOUD_DEFAULT_MODEL` and `cloudModelFor`. `PiRun` passes the agent's model through `cloudModelFor`, so the form's default `sonnet` resolves to `claude-sonnet-5-5`. An unknown id passes through unchanged. The agent form's hint for cloud agents names the aliases from the list.

## Checks

- `bun run check`, `bun run test` and `bun run build` pass. The `drizzle` grep on `apps/web/dist/client` finds nothing.
- Fake Messages server (`pi-run-credentials.test.ts`): the request carries `x-api-key` with the workspace key and the reply comes back. With no workspace key and an `ANTHROPIC_API_KEY` set in `process.env`, the call fails with the no-key message and the server sees no request.
- Live, on `vite dev`, local D1: a cloud agent with model `sonnet` and no workspace key ended `failed` with the no-key message, even though `.env.local` holds `ANTHROPIC_API_KEY`. After the key from `.env.local` was stored as the workspace key (`managedKeys.set`, local database only), the same agent answered "Reply with the word pelican" with `pelican`. A grep for the plaintext key in `apps/web/.wrangler` (D1, Durable Object and trace stores) and in the dev server log found nothing.
- An agent with an unknown model id (`claude-nope-1`) ended `failed` with `no_model`. See nit 6.

## Nits left

1. `cloud/models.ts` repeats the list in `managed/config.ts` (same ids, labels, descriptions). The lookups differ on purpose: an unknown id passes through here and falls back to the default there.
2. `agent-form.tsx` is the first component to import a runtime value from `@repo/services` (a module with no imports, so the bundle stays clean). It bends the layering rule in CLAUDE.md.
3. `WORKSPACE_KEY` is written in `startRun` only. A `PiRun` object created before this change, with runs in flight, would fail them with the no-key message after an eviction. Only old local state is affected.
4. No test covers the `authContext` override in `pi-run-models.ts` alone. The store throws first, so deleting the override would not fail a test.
5. A long one-line JSDoc on `WORKSPACE_KEY` in `pi-run.ts`.
6. An unknown model id fails the run with Pi's `no_model`, which does not say which model or what the choices are. Catching it earlier, at agent save or at dispatch, needs care: a failure in `startRun` releases the claim and the sweep retries it forever.

## Ideas beyond the scope

- A per-model picker (a select fed by `CLOUD_MODELS`) in the agent form instead of a free text field.
- Route a cloud run's model calls through Cloudflare AI Gateway. The base URL belongs in the provider's `auth.resolve()`, not on the provider object (spike report, section 5).
- Map Pi's per-model usage into `usage` on `completeRun` (spike report, section 2).

## Steps for Dom

None. The workspace key is the one Managed Agents already uses (Settings, Managed Agents). A cloud agent on a workspace without it fails with the message above.
