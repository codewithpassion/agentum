/**
 * A workspace's own Anthropic API key, for its Managed Agents runs. The key is
 * write-only: `status` reports four characters of it, and the plaintext leaves
 * the service only through `resolve`, which the runtime calls.
 *
 * Every Anthropic-side id a workspace holds belongs to the key that made it, so
 * setting or removing the key clears its managed sessions and agents. Nothing
 * is deleted on Anthropic's side: the old key may already be revoked.
 *
 * No method, error or log line carries the plaintext key. A rejected key is
 * refused without echoing it, and a failed live check is a no, not its reason.
 */
import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import {
  managedAgents,
  managedSessions,
  workspaceAnthropicKeys,
} from "@repo/db/schema/managed";
import { eq } from "drizzle-orm";
import { authorize, ForbiddenError } from "../authz.ts";
import {
  decryptSecret,
  encryptSecret,
  importSecretsKey,
  type SecretBinding,
} from "../crypto.ts";
import { ServiceError } from "../errors.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";

const KEY_KIND = "workspace_anthropic_key";
const READ_ACTION = "managed.keys.read";
const WRITE_ACTION = "managed.keys.write";

const ANTHROPIC_KEY_PREFIX = "sk-ant-";
/** Well clear of any real key. The point is to bound the encrypt, not to fit. */
const ANTHROPIC_KEY_MAX_LENGTH = 512;
const HINT_LENGTH = 4;

const binding = (workspaceId: string): SecretBinding => ({
  field: "api_key",
  rowId: workspaceId,
  table: "workspace_anthropic_keys",
  workspaceId,
});

type UserPrincipal = Extract<Principal, { kind: "user" }>;

export interface ManagedKeyStatus {
  configured: boolean;
  hint: string | null;
  updatedAt: string | null;
}

export interface ManagedKeyResolution {
  apiKey: string;
  environmentId: string | null;
}

const NOT_CONFIGURED: ManagedKeyStatus = {
  configured: false,
  hint: null,
  updatedAt: null,
};

/** Only a signed-in user may set or remove the key. */
const requireUser = (principal: Principal, action: string): UserPrincipal => {
  if (principal.kind !== "user") {
    throw new ForbiddenError(action);
  }
  return principal;
};

/** The workspace a non-system principal reads from. */
const readableWorkspace = (principal: Principal, action: string): string => {
  if (principal.kind === "system") {
    throw new ForbiddenError(action);
  }
  return principal.workspaceId;
};

/** Shape only. Whether the key works is what `validate` is for. */
const checkShape = (apiKey: string): void => {
  if (!apiKey.startsWith(ANTHROPIC_KEY_PREFIX)) {
    throw new ServiceError(
      "invalid",
      "An Anthropic API key starts with sk-ant-"
    );
  }
  if (apiKey.length > ANTHROPIC_KEY_MAX_LENGTH) {
    throw new ServiceError(
      "invalid",
      `An Anthropic API key is at most ${ANTHROPIC_KEY_MAX_LENGTH} characters`
    );
  }
};

export const createManagedKeysService = ({
  atomic,
  clock,
  db,
  secretsKey,
  validate,
}: {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  /** `SECRETS_KEY`, base64. Needed to store or read the key. */
  secretsKey?: string;
  /** The caller's live check against the API. Absent, only the shape is checked. */
  validate?: (apiKey: string) => Promise<boolean>;
}) => {
  let importedKey: Promise<CryptoKey> | undefined;
  const cryptoKey = (): Promise<CryptoKey> => {
    if (!secretsKey) {
      throw new Error(
        "Storing the Anthropic key needs secretsKey (SECRETS_KEY)."
      );
    }
    importedKey ??= importSecretsKey(secretsKey);
    return importedKey;
  };

  const statusOf = async (workspaceId: string): Promise<ManagedKeyStatus> => {
    const [row] = await db
      .select({
        keyHint: workspaceAnthropicKeys.keyHint,
        updatedAt: workspaceAnthropicKeys.updatedAt,
      })
      .from(workspaceAnthropicKeys)
      .where(eq(workspaceAnthropicKeys.workspaceId, workspaceId))
      .limit(1);
    if (!row) {
      return NOT_CONFIGURED;
    }
    return { configured: true, hint: row.keyHint, updatedAt: row.updatedAt };
  };

  /** Whether Anthropic accepts the key. A thrown check counts as a no. */
  const accepted = async (apiKey: string): Promise<boolean> => {
    if (!validate) {
      return true;
    }
    try {
      return await validate(apiKey);
    } catch {
      // An SDK error can quote the request, and so the key. Its words stay out.
      return false;
    }
  };

  /** Deletes of the Anthropic ids made under the old key, to land in the same atomic write as the key change. */
  const forgetAnthropicIds = (workspaceId: string): Statement[] => [
    db
      .delete(managedSessions)
      .where(eq(managedSessions.workspaceId, workspaceId)),
    db.delete(managedAgents).where(eq(managedAgents.workspaceId, workspaceId)),
  ];

  /** The status the caller may see: its own workspace's, never the key. */
  const status = async (principal: Principal): Promise<ManagedKeyStatus> => {
    const workspaceId = readableWorkspace(principal, READ_ACTION);
    authorize(principal, READ_ACTION, { kind: KEY_KIND, workspaceId });
    return await statusOf(workspaceId);
  };

  /** Stores a new key, or rotates the old one. Clears the workspace's Anthropic ids. */
  const set = async (
    principal: Principal,
    input: { apiKey: string }
  ): Promise<ManagedKeyStatus> => {
    const user = requireUser(principal, WRITE_ACTION);
    const { workspaceId } = user;
    authorize(user, WRITE_ACTION, { kind: KEY_KIND, workspaceId });

    const apiKey = input.apiKey.trim();
    checkShape(apiKey);
    // Before the key leaves for the API: a missing secretsKey fails here.
    const key = await cryptoKey();
    if (!(await accepted(apiKey))) {
      throw new ServiceError("invalid", "Anthropic did not accept that key");
    }

    const now = clock.now().toISOString();
    const apiKeyEnc = await encryptSecret(key, binding(workspaceId), apiKey);
    // One write: a key change that left the old ids behind would make every
    // later run reuse an agent that belongs to the old key.
    await atomic([
      db
        .insert(workspaceAnthropicKeys)
        .values({
          apiKeyEnc,
          createdAt: now,
          environmentId: null,
          keyHint: apiKey.slice(-HINT_LENGTH),
          setBy: user.userId,
          updatedAt: now,
          workspaceId,
        })
        .onConflictDoUpdate({
          set: {
            apiKeyEnc,
            environmentId: null,
            keyHint: apiKey.slice(-HINT_LENGTH),
            setBy: user.userId,
            updatedAt: now,
          },
          target: workspaceAnthropicKeys.workspaceId,
        }),
      ...forgetAnthropicIds(workspaceId),
    ]);
    return await statusOf(workspaceId);
  };

  /** Removes the key and the Anthropic ids made under it. Idempotent. */
  const remove = async (principal: Principal): Promise<ManagedKeyStatus> => {
    const user = requireUser(principal, WRITE_ACTION);
    const { workspaceId } = user;
    authorize(user, WRITE_ACTION, { kind: KEY_KIND, workspaceId });

    await atomic([
      db
        .delete(workspaceAnthropicKeys)
        .where(eq(workspaceAnthropicKeys.workspaceId, workspaceId)),
      ...forgetAnthropicIds(workspaceId),
    ]);
    return NOT_CONFIGURED;
  };

  /** The decrypted key for the runtime. Null when the workspace has none. */
  const resolve = async (
    workspaceId: string
  ): Promise<ManagedKeyResolution | null> => {
    const [row] = await db
      .select({
        apiKeyEnc: workspaceAnthropicKeys.apiKeyEnc,
        environmentId: workspaceAnthropicKeys.environmentId,
      })
      .from(workspaceAnthropicKeys)
      .where(eq(workspaceAnthropicKeys.workspaceId, workspaceId))
      .limit(1);
    if (!row) {
      return null;
    }
    const apiKey = await decryptSecret(
      await cryptoKey(),
      binding(workspaceId),
      row.apiKeyEnc
    );
    return { apiKey, environmentId: row.environmentId };
  };

  /** Records the workspace's environment, if the workspace has a key row. */
  const rememberEnvironment = async (
    workspaceId: string,
    environmentId: string
  ): Promise<void> => {
    await db
      .update(workspaceAnthropicKeys)
      .set({ environmentId })
      .where(eq(workspaceAnthropicKeys.workspaceId, workspaceId));
  };

  return { rememberEnvironment, remove, resolve, set, status };
};

export type ManagedKeysService = ReturnType<typeof createManagedKeysService>;
