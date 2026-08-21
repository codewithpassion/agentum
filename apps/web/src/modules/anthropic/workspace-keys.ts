import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "#/crypto";
import type { Db } from "#/db/client";
import {
  listAgents,
  markAgentsForConnectorResync,
  resetAnthropicRegistrationForWorkspace,
} from "#/modules/agents/service";
import { clearVaultRefsForWorkspace } from "#/modules/connectors/service";
import { resetAnthropicMirrorForWorkspace } from "#/modules/skills/service";
import {
  appConfig,
  environmentIdKeyFor,
  workspaceAnthropicKeys,
} from "./schema";

/**
 * A workspace's own Anthropic API key: storing it, describing it, and - in the
 * one function allowed to decrypt it - resolving which key a workspace's calls
 * should run on.
 *
 * The key is write-only from the outside. It goes in encrypted, it comes back
 * out as four characters, and the plaintext exists only inside
 * `resolveAnthropicKey`. Nothing here logs it, and nothing here puts it in an
 * error message - a rejected key must not be echoed back to whoever pasted it.
 */

const E2E_MODE = "e2e";
const HINT_LENGTH = 4;

/** Anthropic's own prefix. A cheap way to catch a paste of the wrong secret. */
export const ANTHROPIC_KEY_PREFIX = "sk-ant-";

/** Well clear of any real key; the point is to bound the encrypt, not to fit. */
export const ANTHROPIC_KEY_MAX_LENGTH = 512;

/** Shape only - whether the key *works* is what the live check is for. */
export const isAnthropicKeyShaped = (apiKey: string): boolean =>
  apiKey.startsWith(ANTHROPIC_KEY_PREFIX) &&
  apiKey.length <= ANTHROPIC_KEY_MAX_LENGTH;

/**
 * `CONNECTOR_KEY` is unset, so there is nothing to encrypt or decrypt with.
 * Typed so the transport can answer "the deployment is not configured" rather
 * than turning a missing secret into a 500.
 */
export class MissingConnectorKeyError extends Error {
  constructor() {
    super(
      "CONNECTOR_KEY is not configured. Set it (a base64 32-byte key) before storing a workspace API key."
    );
  }
}

const requireConnectorKey = (env: Env): string => {
  if (!env.CONNECTOR_KEY) {
    throw new MissingConnectorKeyError();
  }
  return env.CONNECTOR_KEY;
};

/** Everything a client may know about the key: never the key. */
export interface WorkspaceAnthropicKeyStatus {
  configured: boolean;
  /** The last four characters, or null. The `…` is the caller's to render. */
  hint: string | null;
  setAt: Date | null;
}

const NOT_CONFIGURED: WorkspaceAnthropicKeyStatus = {
  configured: false,
  hint: null,
  setAt: null,
};

const readRow = async (db: Db, workspaceId: string) => {
  const [row] = await db
    .select()
    .from(workspaceAnthropicKeys)
    .where(eq(workspaceAnthropicKeys.workspaceId, workspaceId));
  return row;
};

export const getWorkspaceAnthropicKeyStatus = async (
  db: Db,
  workspaceId: string
): Promise<WorkspaceAnthropicKeyStatus> => {
  const row = await readRow(db, workspaceId);
  if (!row) {
    return NOT_CONFIGURED;
  }
  // `setByClerkUserId` is deliberately not here: it is an audit column, and a
  // Clerk id must never reach a client.
  return { configured: true, hint: row.keyHint, setAt: row.updatedAt };
};

/**
 * Every Anthropic-side id this workspace holds, forgotten.
 *
 * Agents, vault credentials and skills are all scoped to the API key they were
 * created under, so a key change makes every stored id address nothing. Each
 * module clears its own rows - this composes them and takes the environment
 * cache entry, which is the one row this module owns.
 *
 * Nothing is deleted on Anthropic's side: the old key may already be revoked,
 * and a failed cleanup would block a rotation that has to succeed. The existing
 * sync paths recreate what they find missing.
 *
 * Every agent is then marked as owing a full connector push, which is the debt
 * `resyncWorkspaceAfterKeyChange` pays off immediately and the existing pending
 * sweep retries if that first attempt fails. Recording it here rather than
 * there is what makes the debt survive a resync that never got to run.
 *
 * Exported because the resync flows need it too, not only set/rotate/delete.
 */
export const resetWorkspaceAnthropicResources = async (
  db: Db,
  workspaceId: string
): Promise<void> => {
  await resetAnthropicRegistrationForWorkspace(db, workspaceId);
  await clearVaultRefsForWorkspace(db, workspaceId);
  await resetAnthropicMirrorForWorkspace(db, workspaceId);
  await db
    .delete(appConfig)
    .where(eq(appConfig.key, environmentIdKeyFor(workspaceId)));
  await markAgentsForConnectorResync(
    db,
    (await listAgents(db, workspaceId)).map((agent) => agent.id)
  );
};

/**
 * Proves a candidate key against the API before it is stored, with the cheapest
 * authenticated call there is. Fail closed: anything other than a clean
 * response is a no, and the reason is swallowed rather than surfaced, because
 * an SDK error can quote the request it was made with.
 *
 * Skipped under `--mode e2e` for the same reason `isAnthropicEnabled` checks
 * it: the end-to-end suite loads the real `.env.local` and must reach no
 * Anthropic endpoint.
 */
export const validateAnthropicKey = async (
  apiKey: string
): Promise<boolean> => {
  if (import.meta.env.MODE === E2E_MODE) {
    return true;
  }
  try {
    await new Anthropic({ apiKey }).models.list({ limit: 1 });
    return true;
  } catch {
    return false;
  }
};

export interface SetWorkspaceAnthropicKeyInput {
  apiKey: string;
  clerkUserId: string;
  workspaceId: string;
}

/**
 * Set and rotate are one operation - the row is a single upsert keyed by the
 * workspace, and both invalidate exactly the same resources. The caller
 * validates first; by the time this runs the key is known good.
 *
 * `updatedAt` is written explicitly: the column default fires on insert only,
 * and a rotation has to move the date the settings page shows.
 */
export const setWorkspaceAnthropicKey = async (
  db: Db,
  env: Env,
  input: SetWorkspaceAnthropicKeyInput
): Promise<WorkspaceAnthropicKeyStatus> => {
  const apiKeyEnc = await encryptSecret(requireConnectorKey(env), input.apiKey);
  const keyHint = input.apiKey.slice(-HINT_LENGTH);

  await db
    .insert(workspaceAnthropicKeys)
    .values({
      apiKeyEnc,
      keyHint,
      setByClerkUserId: input.clerkUserId,
      workspaceId: input.workspaceId,
    })
    .onConflictDoUpdate({
      set: {
        apiKeyEnc,
        keyHint,
        setByClerkUserId: input.clerkUserId,
        updatedAt: new Date(),
      },
      target: workspaceAnthropicKeys.workspaceId,
    });

  // Unconditional, including on a first set: whatever this workspace has
  // registered so far was created under the global key.
  await resetWorkspaceAnthropicResources(db, input.workspaceId);
  return await getWorkspaceAnthropicKeyStatus(db, input.workspaceId);
};

/**
 * Removes the key, and with it everything registered under it - the workspace
 * falls back to the deployment-global key, which knows none of those ids.
 *
 * Idempotent, and deliberately so: with no row there was no workspace key, so
 * the workspace was already on the global key and its registrations are the
 * ones that key made. Resetting them would be pure damage.
 */
export const deleteWorkspaceAnthropicKey = async (
  db: Db,
  workspaceId: string
): Promise<WorkspaceAnthropicKeyStatus> => {
  const deleted = await db
    .delete(workspaceAnthropicKeys)
    .where(eq(workspaceAnthropicKeys.workspaceId, workspaceId))
    .returning({ workspaceId: workspaceAnthropicKeys.workspaceId });

  if (deleted.length > 0) {
    await resetWorkspaceAnthropicResources(db, workspaceId);
  }
  return NOT_CONFIGURED;
};

export interface ResolvedAnthropicKey {
  apiKey: string;
  /** Which environment cache entry this key's resources belong to. */
  source: "global" | "workspace";
}

/**
 * The key a workspace's Anthropic calls run on, and the only place a stored key
 * is decrypted. Null means neither the workspace nor the deployment has one,
 * which is the "integration is off" case every caller already handles.
 *
 * A configured workspace whose `CONNECTOR_KEY` is missing throws rather than
 * quietly falling back: falling back would run the workspace's agents on -
 * and bill - the deployment's key, which is the one thing configuring your own
 * key is meant to prevent.
 */
export const resolveAnthropicKey = async (
  db: Db,
  env: Env,
  workspaceId: string
): Promise<ResolvedAnthropicKey | null> => {
  const row = await readRow(db, workspaceId);
  if (row) {
    return {
      apiKey: await decryptSecret(requireConnectorKey(env), row.apiKeyEnc),
      source: "workspace",
    };
  }
  return env.ANTHROPIC_API_KEY
    ? { apiKey: env.ANTHROPIC_API_KEY, source: "global" }
    : null;
};
