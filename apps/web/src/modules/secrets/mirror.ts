import type { Db } from "#/db/client";
import {
  clearSecretsVaultId,
  ensureSecretsVault,
  secretsVaultIdFor,
} from "#/modules/anthropic/service";
import {
  createVaults,
  MAX_VAULT_CREDENTIALS,
  type SecretVaultGateway,
} from "#/modules/anthropic/vaults";
import type { WorkspaceSecret } from "./schema";
import {
  listWorkspaceSecretRows,
  type ResolvedSecret,
  recordSecretSync,
  resolveSecretForMirror,
} from "./service";

/**
 * The seam between the secret row and its copy in Anthropic's vault.
 *
 * A secret is usable on both runtimes through the `http_request` tool with no
 * mirror at all; the mirror exists so a skill script in a *managed* agent's
 * sandbox can `curl -H "Authorization: Token $DEEPGRAM_API_KEY"` and get egress
 * substitution from Anthropic. The D1 row is the source of truth and the vault
 * credential is a copy of it, exactly as connectors are.
 *
 * `modules/anthropic` owns the API client and the payloads: everything here goes
 * through `SecretVaultGateway`, so no SDK type crosses into this module. Each
 * entry point comes in two halves - a `…With` core that takes the gateway, which
 * is what the tests drive, and the route-facing wrapper that resolves one from
 * the workspace's API key.
 *
 * Every caller invokes the wrappers as background work through
 * `executionCtx.waitUntil`: a mirror failure must never block a save, and the
 * failure is recorded on the row (`sync_status` / `sync_error`) rather than
 * raised. A workspace with no Anthropic key mirrors nothing and that is not an
 * error - `createVaults` returns null and the row keeps whatever status it had,
 * exactly as a connector added without a key keeps its own.
 */

/**
 * Over the cap the secret still works everywhere except a managed agent's
 * sandbox, so the message says which half is missing rather than reading as a
 * failure to store anything.
 */
const CAP_MESSAGE = `Not mirrored to Anthropic: a workspace may keep at most ${MAX_VAULT_CREDENTIALS} secrets in its vault, so this one is not an environment variable in managed sandboxes. It still works through http_request. To mirror it, delete one of the others and then save this secret again.`;

/**
 * How many of the workspace's secrets hold a credential. Counting our own rows
 * is the only way to say anything useful: the 21st create fails with a bare
 * "The request was invalid".
 */
const mirroredCount = (rows: readonly WorkspaceSecret[]): number =>
  rows.filter((row) => row.vaultCredentialId).length;

/**
 * What goes in `sync_error`, which reaches the settings screen. An SDK error can
 * quote the request it was made with, and this request carries the plaintext -
 * so the value is taken back out of whatever we are about to store.
 */
const mirrorError = (error: unknown, value?: string): string => {
  const message = error instanceof Error ? error.message : String(error);
  return value ? message.replaceAll(value, "[REDACTED]") : message;
};

/**
 * Push a secret into the workspace's secrets vault: create the
 * `environment_variable` credential, or update the one this row already names.
 *
 * The cap check and the gateway come before the decrypt, so a push that will not
 * be made never holds a plaintext. `secret_name` is immutable on Anthropic's
 * side, but so is a secret's name here, so an update never has to archive and
 * recreate.
 */
export const syncSecretMirrorWith = async (
  db: Db,
  env: Env,
  vaults: SecretVaultGateway,
  workspaceId: string,
  secretId: string
): Promise<void> => {
  const rows = await listWorkspaceSecretRows(db, workspaceId);
  const secret = rows.find((row) => row.id === secretId);
  if (!secret) {
    // Deleted while this waited behind the response. Nothing to mirror, and
    // nothing to record it on.
    return;
  }

  // Only a secret that has no credential yet can be the one refused: the ones
  // already in the vault work, and taking one out to make room for a newcomer
  // would be a save silently breaking a sandbox that was running.
  if (
    !secret.vaultCredentialId &&
    mirroredCount(rows) >= MAX_VAULT_CREDENTIALS
  ) {
    await recordSecretSync(db, secretId, {
      error: CAP_MESSAGE,
      status: "error",
    });
    return;
  }

  let resolved: ResolvedSecret | null = null;
  try {
    resolved = await resolveSecretForMirror(db, env, workspaceId, secretId);
    if (!resolved) {
      return;
    }
    const vaultId = await ensureSecretsVault(db, vaults, workspaceId);

    if (secret.vaultCredentialId) {
      await vaults.updateEnvVarCredential({
        allowedHosts: resolved.allowedHosts,
        credentialId: secret.vaultCredentialId,
        value: resolved.value,
        vaultId,
      });
      await recordSecretSync(db, secretId, { status: "synced" });
      return;
    }

    const credentialId = await vaults.createEnvVarCredential({
      allowedHosts: resolved.allowedHosts,
      displayName: resolved.name,
      secretId,
      secretName: resolved.name,
      value: resolved.value,
      vaultId,
    });
    await recordSecretSync(db, secretId, {
      status: "synced",
      vaultCredentialId: credentialId,
    });
  } catch (error) {
    await recordSecretSync(db, secretId, {
      error: mirrorError(error, resolved?.value),
      status: "error",
    });
  }
};

export const syncSecretMirror = async (
  db: Db,
  env: Env,
  workspaceId: string,
  secretId: string
): Promise<void> => {
  const vaults = await createVaults(db, env, workspaceId);
  if (!vaults) {
    return;
  }
  await syncSecretMirrorWith(db, env, vaults, workspaceId, secretId);
};

/**
 * Every secret of the workspace, pushed again.
 *
 * The key-change reset forgets each row's `vault_credential_id` and the vault
 * they lived in, and - unlike an agent, which owes a connector push the pending
 * sweep retries - nothing else would ever rebuild them: a secret is pushed when
 * it is saved, and a rotation nobody follows with a save would leave every
 * managed sandbox quietly missing every environment variable. So the key change
 * calls this.
 *
 * One row at a time, and each one records its own outcome, so a single failure
 * neither stops the sweep nor reaches the caller.
 */
export const syncWorkspaceSecretMirrorsWith = async (
  db: Db,
  env: Env,
  vaults: SecretVaultGateway,
  workspaceId: string
): Promise<void> => {
  for (const row of await listWorkspaceSecretRows(db, workspaceId)) {
    // biome-ignore lint/performance/noAwaitInLoops: paced to stay inside the API's rate limits
    await syncSecretMirrorWith(db, env, vaults, workspaceId, row.id).catch(
      () => {
        // Recorded on the secret row; nothing here is worth stopping the sweep.
      }
    );
  }
};

export const syncWorkspaceSecretMirrors = async (
  db: Db,
  env: Env,
  workspaceId: string
): Promise<void> => {
  // Asked before the gateway, so a workspace with no secrets costs nothing at
  // all - not even resolving the key it just set.
  if ((await listWorkspaceSecretRows(db, workspaceId)).length === 0) {
    return;
  }
  const vaults = await createVaults(db, env, workspaceId);
  if (!vaults) {
    return;
  }
  await syncWorkspaceSecretMirrorsWith(db, env, vaults, workspaceId);
};

/**
 * Archive the credential mirroring one secret, because the secret is going.
 *
 * **Takes the row, not its id.** This runs in the background while the delete
 * proceeds, so by the time it executes the row may already be gone - a
 * `getSecret` here would race the DELETE and, on real D1 where the two are
 * independent round trips, usually lose. Everything the archive needs
 * (`vaultCredentialId`, `workspaceId`) is on the row the caller already holds.
 *
 * Archive rather than delete, because it frees the `secret_name` for reuse in
 * the same vault (spike). Renaming a secret is a delete and a create, so the new
 * credential asks for a name this one just gave up.
 */
export const removeSecretMirrorWith = async (
  db: Db,
  vaults: SecretVaultGateway,
  secret: WorkspaceSecret
): Promise<void> => {
  if (!secret.vaultCredentialId) {
    return;
  }
  const vaultId = await secretsVaultIdFor(db, secret.workspaceId);
  if (!vaultId) {
    return;
  }
  await vaults.archiveCredential({
    credentialId: secret.vaultCredentialId,
    vaultId,
  });
};

export const removeSecretMirror = async (
  db: Db,
  env: Env,
  secret: WorkspaceSecret
): Promise<void> => {
  const vaults = await createVaults(db, env, secret.workspaceId);
  if (!vaults) {
    return;
  }
  await removeSecretMirrorWith(db, vaults, secret);
};

/**
 * Delete the workspace's whole secrets vault, because the workspace is going.
 *
 * **This one runs after the rows are already deleted** - the workspace delete
 * removes its secrets synchronously and fires this behind the response - so it
 * must find the vault through the `app_config` entry alone and must not expect
 * a `workspace_secrets` row to still exist.
 *
 * The vault goes in one call, credentials and all, the way a connector's does.
 * The cached id is dropped first: a delete that fails leaves a bill to notice,
 * while an id left behind would outlive the workspace that owned it.
 */
export const deleteWorkspaceSecretVaultWith = async (
  db: Db,
  vaults: SecretVaultGateway,
  workspaceId: string
): Promise<void> => {
  const vaultId = await secretsVaultIdFor(db, workspaceId);
  if (!vaultId) {
    return;
  }
  await clearSecretsVaultId(db, workspaceId);
  await vaults.deleteVault(vaultId);
};

export const deleteWorkspaceSecretVault = async (
  db: Db,
  env: Env,
  workspaceId: string
): Promise<void> => {
  const vaults = await createVaults(db, env, workspaceId);
  if (!vaults) {
    return;
  }
  await deleteWorkspaceSecretVaultWith(db, vaults, workspaceId);
};
