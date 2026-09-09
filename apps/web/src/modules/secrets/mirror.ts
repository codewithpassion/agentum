import type { Db } from "#/db/client";
import type { WorkspaceSecret } from "./schema";

/**
 * The seam between the secret row and its copy in Anthropic's vault.
 *
 * A secret is usable on both runtimes through the `http_request` tool with no
 * mirror at all; the mirror exists so a skill script in a *managed* agent's
 * sandbox can `curl -H "Authorization: Token $DEEPGRAM_API_KEY"` and get egress
 * substitution from Anthropic. The D1 row is the source of truth and the vault
 * credential is a copy of it, exactly as connectors are.
 *
 * These are no-ops today. `modules/anthropic` owns the API client and the vault
 * payloads, so the bodies land there (forge 3) and are called from here - which
 * is what keeps `modules/secrets` from importing another module's gateway.
 *
 * Every caller invokes them as background work through `executionCtx.waitUntil`:
 * a mirror failure must never block a save, and the failure is recorded on the
 * row (`sync_status` / `sync_error`) rather than raised. That is why all three
 * return `void` and none of them throws a caller's problem.
 */

/**
 * Push a secret into the workspace's secrets vault: create the
 * `environment_variable` credential, or update the one this row already names.
 *
 * TODO(forge 3): create/update the credential, record the outcome with
 * `recordSecretSync`. `secret_name` is immutable on Anthropic's side, but so
 * is a secret's name here, so an update never has to archive and recreate.
 */
export const syncSecretMirror = async (
  _db: Db,
  _env: Env,
  _workspaceId: string,
  _secretId: string
): Promise<void> => {
  // Intentionally empty until forge 3 lands the vault payloads.
  await Promise.resolve();
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
 * TODO(forge 3): archive the credential named by `secret.vaultCredentialId`.
 */
export const removeSecretMirror = async (
  _db: Db,
  _env: Env,
  _secret: WorkspaceSecret
): Promise<void> => {
  await Promise.resolve();
};

/**
 * Archive the workspace's whole secrets vault, because the workspace is going.
 *
 * **This one runs after the rows are already deleted** - the workspace delete
 * removes its secrets synchronously and fires this behind the response - so it
 * must find the vault through the `app_config` entry alone and must not expect
 * a `workspace_secrets` row to still exist.
 *
 * TODO(forge 3): archive the vault and drop its `app_config` entry.
 */
export const archiveWorkspaceSecretVault = async (
  _db: Db,
  _env: Env,
  _workspaceId: string
): Promise<void> => {
  await Promise.resolve();
};
