import { and, asc, eq, inArray } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "#/crypto";
import type { Db } from "#/db/client";
import {
  agentSecrets,
  type SecretSyncStatus,
  type WorkspaceSecret,
  workspaceSecrets,
} from "./schema";

/**
 * Workspace secrets: storing them, granting them to agents, and - in the two
 * functions allowed to decrypt one - handing a value to the two places that
 * may hold it.
 *
 * The value is write-only from the outside. It goes in encrypted, it comes back
 * out as four characters, and the plaintext exists only inside
 * `resolveSecretForAgent` (the tool path) and `resolveSecretForMirror` (the
 * vault mirror). Nothing here logs it, and **no error message may contain it** -
 * a rejected value must not be echoed back to whoever pasted it, which is the
 * same rule `modules/anthropic/workspace-keys.ts` follows for the API key.
 *
 * Every read and write is workspace-scoped. A secret addressed by a bare id
 * from another workspace is not found, and cannot be told apart from one that
 * never existed.
 */

const HINT_LENGTH = 4;

/**
 * Below this, the last four characters *are* the value, so there is nothing to
 * hint at. Short keys are refused rather than hinted at partially: a hint is
 * shown to every member of the workspace, and half of a six-character token is
 * a meaningful head start on the other half.
 */
export const SECRET_VALUE_MIN_LENGTH = 8;

/** Well clear of any real API key; the point is to bound the encrypt. */
export const SECRET_VALUE_MAX_LENGTH = 4096;

export const SECRET_DESCRIPTION_MAX_LENGTH = 500;

/**
 * Env-var style, because that is what it becomes in a managed agent's sandbox.
 * Two to sixty-four characters, so `A` alone is not a name.
 */
const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

export const isSecretNameShaped = (name: string): boolean =>
  SECRET_NAME.test(name);

/**
 * A header name, per RFC 7230's `token` rule. Checked because the value is
 * injected into a header we build: anything with a colon, a space or a newline
 * in it is a request-splitting attempt rather than a header name.
 */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export const isHeaderNameShaped = (header: string): boolean =>
  HEADER_NAME.test(header);

/**
 * A header *value* may not carry a line break either. The prefix is owner-typed
 * and lands next to the secret in the same header, so it gets the same check.
 */
const HEADER_VALUE_FORBIDDEN = /[\r\n\0]/;

export const isHeaderPrefixShaped = (prefix: string): boolean =>
  !HEADER_VALUE_FORBIDDEN.test(prefix);

/**
 * `CONNECTOR_KEY` is unset, so there is nothing to encrypt or decrypt with.
 * Typed so a route can answer "the deployment is not configured" rather than
 * turning a missing secret into a 500.
 */
export class MissingSecretsKeyError extends Error {
  constructor() {
    super(
      "CONNECTOR_KEY is not configured. Set it (a base64 32-byte key) before storing a workspace secret."
    );
  }
}

const requireConnectorKey = (env: Env): string => {
  if (!env.CONNECTOR_KEY) {
    throw new MissingSecretsKeyError();
  }
  return env.CONNECTOR_KEY;
};

/**
 * What binds a ciphertext to its row. A value copied into another secret's row,
 * or into another tenant's, then fails to decrypt rather than being readable
 * through a row whose grants say something different.
 *
 * The one place this string is built. Both decrypt sites go through it.
 */
const aadFor = (workspaceId: string, secretId: string): string =>
  `${workspaceId}:${secretId}`;

// --- views ------------------------------------------------------------------

/** Everything a client may know about a secret: never the value. */
export interface SecretView {
  /** Which agents hold a grant. Empty unless the caller asked for them. */
  agentIds: string[];
  allowedHosts: string[];
  createdAt: Date;
  description: string;
  header: string;
  headerPrefix: string;
  /** The last four characters. The `…` is the caller's to render. */
  hint: string;
  id: string;
  lastUsedAt: Date | null;
  name: string;
  syncError: string | null;
  syncStatus: SecretSyncStatus;
  updatedAt: Date;
}

/**
 * `valueEnc`, `keyVersion`, `setByClerkUserId` and `vaultCredentialId` are
 * deliberately absent: the first two are the credential, the third is an audit
 * column holding a Clerk id, and the fourth is an Anthropic-side id no client
 * has any use for.
 */
export const toSecretView = (
  secret: WorkspaceSecret,
  agentIds: readonly string[] = []
): SecretView => ({
  agentIds: [...agentIds],
  allowedHosts: secret.allowedHosts,
  createdAt: secret.createdAt,
  description: secret.description,
  header: secret.header,
  headerPrefix: secret.headerPrefix,
  hint: secret.hint,
  id: secret.id,
  lastUsedAt: secret.lastUsedAt,
  name: secret.name,
  syncError: secret.syncError,
  syncStatus: secret.syncStatus,
  updatedAt: secret.updatedAt,
});

/** What an agent is told about a secret it holds: no hint, no id. */
export interface AgentSecretView {
  allowedHosts: string[];
  description: string;
  name: string;
}

// --- reads ------------------------------------------------------------------

export const getSecret = async (
  db: Db,
  workspaceId: string,
  id: string
): Promise<WorkspaceSecret | undefined> => {
  const [secret] = await db
    .select()
    .from(workspaceSecrets)
    .where(
      and(
        eq(workspaceSecrets.workspaceId, workspaceId),
        eq(workspaceSecrets.id, id)
      )
    );
  return secret;
};

/** The raw rows of a workspace. For the mirror; the API goes through `listSecrets`. */
export const listWorkspaceSecretRows = (
  db: Db,
  workspaceId: string
): Promise<WorkspaceSecret[]> =>
  db
    .select()
    .from(workspaceSecrets)
    .where(eq(workspaceSecrets.workspaceId, workspaceId))
    .orderBy(asc(workspaceSecrets.name));

export const listAgentIdsForSecret = async (
  db: Db,
  secretId: string
): Promise<string[]> => {
  const rows = await db
    .select({ agentId: agentSecrets.agentId })
    .from(agentSecrets)
    .where(eq(agentSecrets.secretId, secretId));
  return rows.map((row) => row.agentId);
};

/**
 * The workspace's secrets with their grants, in one pass rather than a query
 * per secret.
 */
export const listSecrets = async (
  db: Db,
  workspaceId: string
): Promise<SecretView[]> => {
  const secrets = await listWorkspaceSecretRows(db, workspaceId);
  if (secrets.length === 0) {
    return [];
  }

  const grants = await db
    .select({
      agentId: agentSecrets.agentId,
      secretId: agentSecrets.secretId,
    })
    .from(agentSecrets)
    .where(
      inArray(
        agentSecrets.secretId,
        secrets.map((secret) => secret.id)
      )
    );

  const bySecret = new Map<string, string[]>();
  for (const grant of grants) {
    const held = bySecret.get(grant.secretId);
    if (held) {
      held.push(grant.agentId);
    } else {
      bySecret.set(grant.secretId, [grant.agentId]);
    }
  }

  return secrets.map((secret) =>
    toSecretView(secret, bySecret.get(secret.id) ?? [])
  );
};

/**
 * The raw rows an agent holds. Workspace-scoped through the secret, so a grant
 * naming an agent of another workspace - which nothing can create - would still
 * find nothing.
 */
export const listSecretRowsForAgent = async (
  db: Db,
  workspaceId: string,
  agentId: string
): Promise<WorkspaceSecret[]> => {
  const rows = await db
    .select({ secret: workspaceSecrets })
    .from(agentSecrets)
    .innerJoin(workspaceSecrets, eq(workspaceSecrets.id, agentSecrets.secretId))
    .where(
      and(
        eq(agentSecrets.agentId, agentId),
        eq(workspaceSecrets.workspaceId, workspaceId)
      )
    )
    .orderBy(asc(workspaceSecrets.name));
  return rows.map((row) => row.secret);
};

/**
 * What `list_secrets` answers: the narrow shape, built here rather than in the
 * tool so no caller can hand an agent a hint or an id by reaching for the row.
 */
export const listSecretsForAgent = async (
  db: Db,
  workspaceId: string,
  agentId: string
): Promise<AgentSecretView[]> =>
  (await listSecretRowsForAgent(db, workspaceId, agentId)).map((secret) => ({
    allowedHosts: secret.allowedHosts,
    description: secret.description,
    name: secret.name,
  }));

/** Whether the agent holds any grant - what decides if its session needs the vault. */
export const agentHasSecrets = async (
  db: Db,
  workspaceId: string,
  agentId: string
): Promise<boolean> =>
  (await listSecretRowsForAgent(db, workspaceId, agentId)).length > 0;

// --- writes -----------------------------------------------------------------

export interface CreateSecretInput {
  allowedHosts: string[];
  clerkUserId: string;
  description?: string;
  header?: string;
  headerPrefix?: string;
  name: string;
  value: string;
}

/**
 * The id is minted before the encrypt because it is half of the AAD: the
 * ciphertext is bound to the row it is about to become.
 *
 * Callers validate `name`, `allowedHosts` and `value` first - the route does,
 * through `hosts.ts` and the shape checks above. A duplicate name surfaces as
 * the unique constraint, which the route turns into a 409.
 */
export const createSecret = async (
  db: Db,
  env: Env,
  workspaceId: string,
  input: CreateSecretInput
): Promise<WorkspaceSecret> => {
  const id = crypto.randomUUID();
  const valueEnc = await encryptSecret(
    requireConnectorKey(env),
    input.value,
    aadFor(workspaceId, id)
  );

  const [secret] = await db
    .insert(workspaceSecrets)
    .values({
      allowedHosts: input.allowedHosts,
      description: input.description ?? "",
      ...(input.header === undefined ? {} : { header: input.header }),
      ...(input.headerPrefix === undefined
        ? {}
        : { headerPrefix: input.headerPrefix }),
      hint: input.value.slice(-HINT_LENGTH),
      id,
      name: input.name,
      setByClerkUserId: input.clerkUserId,
      valueEnc,
      workspaceId,
    })
    .returning();

  if (!secret) {
    throw new Error("The secret could not be stored.");
  }
  return secret;
};

export interface UpdateSecretInput {
  allowedHosts?: string[];
  description?: string;
  header?: string;
  headerPrefix?: string;
  /** A new value: re-encrypted under the same AAD, since the row is the same. */
  value?: string;
}

/**
 * `name` is not updatable, and that is the point: the tool and the sandbox both
 * key on it, so a rename would be a delete and a create wearing a PATCH.
 *
 * `syncStatus` is left exactly as it was. The mirror owns that transition, and
 * setting it here would race the background push the caller is about to fire.
 */
export const updateSecret = async (
  db: Db,
  env: Env,
  workspaceId: string,
  id: string,
  input: UpdateSecretInput
): Promise<WorkspaceSecret | undefined> => {
  const existing = await getSecret(db, workspaceId, id);
  if (!existing) {
    return;
  }

  const rotation =
    input.value === undefined
      ? {}
      : {
          hint: input.value.slice(-HINT_LENGTH),
          valueEnc: await encryptSecret(
            requireConnectorKey(env),
            input.value,
            aadFor(workspaceId, id)
          ),
        };

  const [secret] = await db
    .update(workspaceSecrets)
    .set({
      ...(input.allowedHosts === undefined
        ? {}
        : { allowedHosts: input.allowedHosts }),
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
      ...(input.header === undefined ? {} : { header: input.header }),
      ...(input.headerPrefix === undefined
        ? {}
        : { headerPrefix: input.headerPrefix }),
      ...rotation,
      // Written explicitly: the column default fires on insert only.
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workspaceSecrets.workspaceId, workspaceId),
        eq(workspaceSecrets.id, id)
      )
    )
    .returning();
  return secret;
};

/** The row and its grants. The mirror is archived by the caller, before this. */
export const deleteSecret = async (
  db: Db,
  workspaceId: string,
  id: string
): Promise<boolean> => {
  const secret = await getSecret(db, workspaceId, id);
  if (!secret) {
    return false;
  }
  // `agent_secrets` has no foreign key, so the grants go by hand.
  await db.delete(agentSecrets).where(eq(agentSecrets.secretId, id));
  const deleted = await db
    .delete(workspaceSecrets)
    .where(
      and(
        eq(workspaceSecrets.workspaceId, workspaceId),
        eq(workspaceSecrets.id, id)
      )
    )
    .returning({ id: workspaceSecrets.id });
  return deleted.length > 0;
};

// --- grants -----------------------------------------------------------------

/**
 * Idempotent, and answers whether anything changed so a route can stay quiet
 * about a grant that already existed.
 *
 * Nothing is marked for resync. Unlike a connector, a secret changes nothing on
 * the agent object: the tool reads this join on every call, and the vault ids
 * are fixed when a managed session is created. A grant therefore takes effect
 * on the next tool call immediately, and in the sandbox on the next session.
 */
export const grantSecret = async (
  db: Db,
  secretId: string,
  agentId: string
): Promise<boolean> => {
  const granted = await db
    .insert(agentSecrets)
    .values({ agentId, id: crypto.randomUUID(), secretId })
    .onConflictDoNothing()
    .returning({ id: agentSecrets.id });
  return granted.length > 0;
};

export const revokeSecret = async (
  db: Db,
  secretId: string,
  agentId: string
): Promise<boolean> => {
  const removed = await db
    .delete(agentSecrets)
    .where(
      and(
        eq(agentSecrets.secretId, secretId),
        eq(agentSecrets.agentId, agentId)
      )
    )
    .returning({ id: agentSecrets.id });
  return removed.length > 0;
};

// --- the two decrypt sites --------------------------------------------------

/** A secret's value, with everything the caller needs to inject it. */
export interface ResolvedSecret {
  allowedHosts: string[];
  header: string;
  headerPrefix: string;
  id: string;
  name: string;
  /** The plaintext. Never logged, never returned to a model, never in an error. */
  value: string;
}

const resolvedFrom = async (
  env: Env,
  secret: WorkspaceSecret
): Promise<ResolvedSecret> => ({
  allowedHosts: secret.allowedHosts,
  header: secret.header,
  headerPrefix: secret.headerPrefix,
  id: secret.id,
  name: secret.name,
  value: await decryptSecret(
    requireConnectorKey(env),
    secret.valueEnc,
    aadFor(secret.workspaceId, secret.id)
  ),
});

/**
 * **Decrypt site 1 of 2: the tool path.** The single place `http_request`
 * obtains a value, addressed the way an agent addresses it - by name, scoped to
 * the workspace, and only if the calling agent holds a grant.
 *
 * `null` covers all three misses - no such secret, a secret of another
 * workspace, a secret this agent was not granted - deliberately, and the caller
 * must say the same thing for each: a distinguishable "exists but not yours"
 * tells an agent which names are real.
 */
export const resolveSecretForAgent = async (
  db: Db,
  env: Env,
  input: { agentId: string; name: string; workspaceId: string }
): Promise<ResolvedSecret | null> => {
  const [row] = await db
    .select({ secret: workspaceSecrets })
    .from(agentSecrets)
    .innerJoin(workspaceSecrets, eq(workspaceSecrets.id, agentSecrets.secretId))
    .where(
      and(
        eq(agentSecrets.agentId, input.agentId),
        eq(workspaceSecrets.workspaceId, input.workspaceId),
        eq(workspaceSecrets.name, input.name)
      )
    );

  return row ? await resolvedFrom(env, row.secret) : null;
};

/**
 * **Decrypt site 2 of 2: the vault mirror.** By id, with no grant check: the
 * mirror pushes every secret of the workspace into the workspace's vault, and
 * which agents may use it is decided by whether that vault is attached to their
 * session (plus the tool's own check).
 */
export const resolveSecretForMirror = async (
  db: Db,
  env: Env,
  workspaceId: string,
  secretId: string
): Promise<ResolvedSecret | null> => {
  const secret = await getSecret(db, workspaceId, secretId);
  return secret ? await resolvedFrom(env, secret) : null;
};

/**
 * The audit half of a tool call. Separate from the resolve so a refused call -
 * a host that did not match - does not look like a use.
 *
 * `updatedAt` stays put: this is the tool touching the secret, not an edit
 * anyone made to it.
 */
export const markSecretUsed = async (
  db: Db,
  secretId: string,
  usedAt: Date = new Date()
): Promise<void> => {
  await db
    .update(workspaceSecrets)
    .set({ lastUsedAt: usedAt })
    .where(eq(workspaceSecrets.id, secretId));
};

// --- the mirror's own columns -----------------------------------------------

export interface SecretSyncResult {
  error?: string | null;
  status: SecretSyncStatus;
  vaultCredentialId?: string | null;
}

/**
 * How the mirror reports back. The only writer of `sync_status`, `sync_error`
 * and `vault_credential_id`, so a push and an edit cannot each half-write the
 * pair.
 *
 * `updatedAt` is left alone for the same reason `markSecretUsed` leaves it: the
 * mirror catching up is not an edit, and moving the date would make every
 * settings screen claim the owner changed something.
 */
export const recordSecretSync = async (
  db: Db,
  secretId: string,
  result: SecretSyncResult
): Promise<void> => {
  await db
    .update(workspaceSecrets)
    .set({
      syncError: result.error ?? null,
      syncStatus: result.status,
      ...(result.vaultCredentialId === undefined
        ? {}
        : { vaultCredentialId: result.vaultCredentialId }),
    })
    .where(eq(workspaceSecrets.id, secretId));
};

/**
 * Forgets every Anthropic-side id this workspace's secrets hold, so the resync
 * path recreates them.
 *
 * Called when the workspace's Anthropic API key changes: a vault and its
 * credentials belong to the key that created them, so after a change every
 * stored id addresses nothing. The values are untouched - only the mirror has
 * to be rebuilt. Mirrors `resetAnthropicMirrorForWorkspace` in the skills
 * module, which the key-change reset already composes.
 */
export const resetSecretMirrorForWorkspace = async (
  db: Db,
  workspaceId: string
): Promise<void> => {
  await db
    .update(workspaceSecrets)
    .set({
      syncError: null,
      syncStatus: "unregistered",
      vaultCredentialId: null,
    })
    .where(eq(workspaceSecrets.workspaceId, workspaceId));
};

// --- cleanup ----------------------------------------------------------------

/**
 * Every secret of one workspace, and every grant naming one, for the
 * workspace-delete cleanup.
 *
 * The vault is archived separately and behind the response - see
 * `archiveWorkspaceSecretVault`, which is why it may not expect these rows to
 * still exist.
 */
export const deleteSecretsForWorkspace = async (
  db: Db,
  workspaceId: string
): Promise<void> => {
  const rows = await db
    .select({ id: workspaceSecrets.id })
    .from(workspaceSecrets)
    .where(eq(workspaceSecrets.workspaceId, workspaceId));
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    await db.delete(agentSecrets).where(inArray(agentSecrets.secretId, ids));
  }
  await db
    .delete(workspaceSecrets)
    .where(eq(workspaceSecrets.workspaceId, workspaceId));
};

/**
 * One agent's grants, for the agent-delete cleanup. The secrets themselves
 * belong to the workspace and stay.
 */
export const deleteSecretGrantsForAgent = async (
  db: Db,
  agentId: string
): Promise<void> => {
  await db.delete(agentSecrets).where(eq(agentSecrets.agentId, agentId));
};
