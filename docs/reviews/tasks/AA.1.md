# AA.1 review

## Verdicts

- Round 1 (74a773c): not clean. Two must-fix: `matchRestRoute` threw on a malformed percent escape, and an empty `SecurityRequirement` was refused. Both fixed.
- Round 2 (c04702f, covers the fixes plus the mid-run scope: Hermes tolerance and the pairing columns and table): not clean. One must-fix: `skills` had lost `.min(1)` on a wrong reading of Hermes. Restored. Nits on the Hermes fixture flags and the legacy http scheme mapping also fixed.
- Round 3 (71278c4, fix commit only): clean.

## Nits left

- `taskPushNotificationConfigSchema` refuses Hermes's push-config reply, `{configId, taskId, createdAt, pushNotificationConfig: {url}}`, and Hermes's create call wants a nested `pushNotificationConfig.url`. AA.5 and AA.8 should read this before they register push configs with Hermes.
- `SecurityRequirement.schemes` defaults to `{}`, so Hermes's `security` shape `{bearer: []}` parses as an empty requirement. Cards do not read `security`, so nothing uses it.
- `AgentExtension.uri` and `AgentCard.description` accept empty strings. The proto does not mark `uri` required.
- `APIKeySecurityScheme.location` accepts any string, not only `query`, `header` and `cookie`.
- A JSON-RPC error `data` is any JSON, not only an array.
- `buildJsonRpcResult(id, undefined)` emits a response with no `result`.
- `PROTOCOL_ERRORS` carry invented `reason` values that are never sent.
- `A2A_TASK_STATES` in `@repo/db/shared` repeats `TASK_STATES` in `@repo/a2a`. No test ties them together, because `@repo/a2a` imports nothing from the db package.
- `a2a_push_configs.task_id` and `a2a_tasks.run_id` have no index, and the hourly limit count (connection, created_at) has none. The task did not ask for them.
- The `a2a_connections` slug unique index includes revoked rows, so a reconnect needs a new slug.
- `ON DELETE CASCADE` from `agents` on the new tables follows `triggers`, but a rebuild of `agents` on D1 would wipe them. Nothing deletes agents today.
- `Part` has `kind?: undefined` in its inferred type, from the schema that refuses 0.3 parts.

## Ideas beyond the scope

- A `isBearerScheme(securityScheme)` helper for the outbound client (AA.5).
- Param schemas for `GetTask`, `ListTasks`, `CancelTask` and the push config operations, when AA.2 and AA.5 need them.

## Steps for Dom

None.

## Note for AA.9

`a2a_pairing_requests` keeps only `code_hash`. The design and AA.9 want the same token to get its existing code back, and a hash cannot be read back. AA.9 has to derive the code from the token or store it encrypted, and may need a column for it.
