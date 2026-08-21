# Per-workspace Anthropic API key — implementation plan

## Goal

A workspace owner can configure a workspace-specific Anthropic API key. The key is
usable server-side for all Anthropic calls on behalf of that workspace, manageable
(set / rotate / remove) only by workspace owners, and never retrievable in plaintext
after being set. Workspaces without a key keep using the deployment-global
`ANTHROPIC_API_KEY` exactly as today.

## Locked design decisions

1. **Storage**: new table `workspace_anthropic_keys` in
   `apps/web/src/modules/anthropic/schema.ts` (NOT in the workspaces module — the
   resolver lives in `anthropic/service.ts` and module isolation forbids anthropic
   reaching into workspaces' internals; a separate table also means no `select *`
   on workspaces can ever leak ciphertext). Columns:
   - `workspace_id` text PK (plain text, no FK — module-isolation convention)
   - `api_key_enc` text not null — AES-GCM envelope ciphertext
   - `key_hint` text not null — last 4 chars, computed at write time
   - `set_by_clerk_user_id` text not null — audit only, never serialized to client
   - `created_at` / `updated_at` integer timestamps (follow existing column idioms)
2. **Encryption**: reuse `encryptSecret`/`decryptSecret` from `apps/web/src/crypto.ts`,
   keyed by the existing `CONNECTOR_KEY` Worker secret. (Tradeoff noted: a dedicated
   secret would add ops burden with no real isolation — both live in the same Worker
   env; if that leaks, both leak.) Follow the `requireKey`-style guard pattern from
   `connectors/service.ts` when `CONNECTOR_KEY` is unset.
3. **Write-only semantics**: `key_hint` is computed at write time so display never
   needs decrypt. Decrypt happens in exactly ONE place — the server-side resolver —
   never in a route handler. The key is never logged and never echoed back, including
   in validation-failure error messages.
4. **Resolver contract** (in `anthropic/service.ts` or a small sibling file):
   ```ts
   resolveAnthropicKey(db, env, workspaceId): Promise<{ apiKey: string; source: "workspace" | "global" } | null>
   ```
   Returns the decrypted workspace key when configured, else the global
   `env.ANTHROPIC_API_KEY`, else null. The Anthropic *environment* cache keys off
   `source`: workspace keys use `app_config` key `anthropic.environment_id:<workspaceId>`;
   the global key keeps the existing `anthropic.environment_id` entry. This makes the
   switch-back case correct: workspace deletes its key → falls back to global → uses
   the global environment cache again, never a stale per-workspace entry.
5. **Enabled semantics**: keep `isAnthropicEnabled(env)` sync — but change it to be
   the kill-switch/e2e guard only where needed: "enabled for workspace" = kill switch
   off AND e2e guard off AND (workspace key configured OR global key exists). The
   `ANTHROPIC_DISABLED` and `import.meta.env.MODE !== "e2e"` guards override
   everything, workspace key or not. Do NOT convert existing sync call sites to async;
   let the resolver handle key presence.
6. **Validation on save**: before persisting, make a cheap `client.models.list()`
   call with the candidate key. Fail closed: on failure reject the save with a
   generic message; the key is never persisted or echoed on failure.
7. **Key change = resource reset**: every Anthropic-side resource ID is scoped to
   the API key it was created under. On set, rotate, or delete of a workspace key,
   for that workspace only:
   - agents: `syncStatus = "unregistered"`, `syncError = null`, and null out
     `anthropicAgentId`, `memoryStoreId`, `sessionId`
   - environment cache: delete `app_config` row `anthropic.environment_id:<workspaceId>`
   - connectors: null out `vaultId` / `vaultCredentialId` (they will be recreated by
     the existing sync paths)
   - skills: null out `anthropicSkillId` on `skills` and `anthropicVersion` (and any
     sync-state columns) on `skillVersions` for the workspace's skills, so the
     existing skills-sync path re-registers them
   Then trigger the existing roster/skills resync path if one is callable in-request;
   otherwise rely on the existing lazy resync. Do NOT attempt to delete resources
   under the old key (the old key may already be revoked).
8. **`askFast` (fast.ts)**: change it to accept a pre-resolved API key (or an options
   object containing one). Callers that have a workspaceId resolve first; callers that
   genuinely can't (bridges/thinking.ts today) fall back to the global key. Do NOT
   rewire the Slack bridge to thread workspaceId end-to-end — out of scope.

## API contract (owner-gated, mounted under `workspaceScopedRoutes`)

All under `/api/w/:workspaceSlug/anthropic-key`, following the patterns in
`workspaces/routes.ts` (`requireOwner`, `readJsonObject`/`requireString` from
`#/api/validation`).

- `GET /anthropic-key` — `requireOwner`. Response:
  `{ configured: boolean, hint: string | null, setAt: string | null }`
  (hint like `"…abcd"`; never the key.)
- `PUT /anthropic-key` — `requireOwner`. Body `{ apiKey: string }` (sanity-check the
  `sk-ant-` prefix and a max length before the live validation call). Validates via
  `models.list()`, encrypts, upserts, runs the resource reset (§7). Response: same
  shape as GET. Errors: 400 invalid format, 422 (or 400) failed live validation with
  a generic message, 503-style error if `CONNECTOR_KEY` unset.
- `DELETE /anthropic-key` — `requireOwner`. Deletes the row, runs the resource
  reset (§7) (workspace falls back to the global key). Response: same shape as GET.

## UI

One new owner-only `<Section title="Anthropic API key">` in
`apps/web/src/components/tenant/members-settings.tsx`, gated by the existing
`isOwner` flag, using `useActiveWorkspace()` and the existing `run()`/busy/error
pattern on that page:

- shows configured status + hint + set date, or "not configured — using the
  platform default key"
- password-type input to set/rotate, Remove button when configured
- an explicit warning on set/rotate/remove: **this resets the workspace's agents,
  connector credentials, and skills on Anthropic's side; they will re-register on
  next sync** (user-visible destructive side effect, not an implementation detail)

## Work split

- **Forge 1 — backend core** (first, blocking): schema + migration
  (`drizzle-kit generate`, `0020_*`; table lives in the anthropic module's existing
  schema.ts so no drizzle.config change), key service (encrypt/store/hint/reset),
  resolver, routes, tests.
- **Forge 2 — integration** (after 1): thread the resolved key through
  `service.ts` (`createGateway`), `gateway.ts` environment cache (per-workspace key),
  `vaults.ts` (`createVaults`), `skills-gateway.ts` (`createSkills`), `fast.ts`
  (`askFast`), and the `AgentRouter` DO call site; wire the §7 reset into the
  existing resync flows; tests.
- **Forge 3 — frontend** (parallel with 2, disjoint files): the settings Section
  against the API contract above.

Verification: `bun test` (targeted + full at the end), `bun x ultracite check` on
touched files only, `bun run db:migrate:local` applies cleanly. Commit locally in
the worktree; **no push** (do not publish).
