/**
 * A workspace's own key for a model provider, such as OpenRouter. The key is
 * write-only: `status` reports the last four characters, and the plaintext
 * leaves the service only through `resolve`, which the model gateway calls.
 *
 * Kept apart from the Managed Agents key on purpose. Changing a model key
 * touches no Anthropic-side ids, so set and remove write one row and nothing
 * else.
 *
 * The secrets service is not used here. A model key is read by the gateway
 * that calls the provider, and it must never reach an agent's environment.
 *
 * No method, error or log line carries the plaintext key. A rejected key is
 * refused without echoing it, and a live check that could not run is refused
 * in words of our own, never the provider's.
 */
import type { Database } from "@repo/db";
import { workspaceModelKeys } from "@repo/db/schema/model-keys";
import type { ModelProvider } from "@repo/db/shared";
import { and, eq } from "drizzle-orm";
import { authorize, ForbiddenError } from "./authz.ts";
import {
  decryptSecret,
  encryptSecret,
  importSecretsKey,
  type SecretBinding,
} from "./crypto.ts";
import { ServiceError } from "./errors.ts";
import type { Clock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

/**
 * What a run says when its workspace has no key for the provider. The
 * sentence names the Settings section where the key is added.
 */
export const NO_KEY_MESSAGES: Record<ModelProvider, string> = {
  openrouter:
    "This workspace has no OpenRouter API key. Add one in Settings, Model providers.",
};

const PROVIDER_NAMES: Record<ModelProvider, string> = {
  openrouter: "OpenRouter",
};

const KEY_KIND = "workspace_model_key";
const READ_ACTION = "model-keys.read";
const WRITE_ACTION = "model-keys.write";

/** A key is shorter than this. Well clear of any real key, the point is to bound the encrypt. */
const KEY_LENGTH_LIMIT = 512;
const HINT_LENGTH = 4;

const OPENROUTER_KEYS_URL = "https://openrouter.ai/api/v1/models/user";

const binding = (
  workspaceId: string,
  provider: ModelProvider
): SecretBinding => ({
  field: "api_key",
  rowId: `${workspaceId}:${provider}`,
  table: "workspace_model_keys",
  workspaceId,
});

type UserPrincipal = Extract<Principal, { kind: "user" }>;

export interface ModelKeyStatus {
  configured: boolean;
  hint: string | null;
  updatedAt: string | null;
}

const NOT_CONFIGURED: ModelKeyStatus = {
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

/** Shape only. Whether the provider accepts the key is what `validate` is for. */
const checkShape = (apiKey: string): void => {
  if (apiKey.length === 0) {
    throw new ServiceError("invalid", "An API key is required");
  }
  if (apiKey.length >= KEY_LENGTH_LIMIT) {
    throw new ServiceError(
      "invalid",
      `An API key must be under ${KEY_LENGTH_LIMIT} characters`
    );
  }
};

/**
 * Whether OpenRouter accepts the key. A 401 or 403 is a no. Any other failure
 * (a 5xx, a 429) is a throw, so the caller cannot mistake an outage for a bad
 * key. The message never includes the key.
 */
export const validateOpenRouterKey = async (
  apiKey: string,
  fetcher: typeof fetch = fetch
): Promise<boolean> => {
  const response = await fetcher(OPENROUTER_KEYS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (response.ok) {
    return true;
  }
  if (response.status === 401 || response.status === 403) {
    return false;
  }
  throw new Error(`OpenRouter answered ${response.status}`);
};

const VALIDATORS: Record<ModelProvider, (apiKey: string) => Promise<boolean>> =
  {
    openrouter: (apiKey) => validateOpenRouterKey(apiKey),
  };

/**
 * The live check for a provider. Typed as a record over `ModelProvider`, so a
 * new provider fails to type-check until it has a validator here.
 */
export const validateModelKey = (
  provider: ModelProvider,
  apiKey: string
): Promise<boolean> => VALIDATORS[provider](apiKey);

export const createModelKeysService = ({
  clock,
  db,
  secretsKey,
  validate,
}: {
  clock: Clock;
  db: Database;
  /** `SECRETS_KEY`, base64. Needed to store or read the key. */
  secretsKey?: string;
  /** The caller's live check against the provider. Absent, only the shape is checked. */
  validate?: (provider: ModelProvider, apiKey: string) => Promise<boolean>;
}) => {
  let importedKey: Promise<CryptoKey> | undefined;
  const cryptoKey = (): Promise<CryptoKey> => {
    if (!secretsKey) {
      throw new Error("Storing a model key needs secretsKey (SECRETS_KEY).");
    }
    importedKey ??= importSecretsKey(secretsKey);
    return importedKey;
  };

  const statusOf = async (
    workspaceId: string,
    provider: ModelProvider
  ): Promise<ModelKeyStatus> => {
    const [row] = await db
      .select({
        keyHint: workspaceModelKeys.keyHint,
        updatedAt: workspaceModelKeys.updatedAt,
      })
      .from(workspaceModelKeys)
      .where(
        and(
          eq(workspaceModelKeys.workspaceId, workspaceId),
          eq(workspaceModelKeys.provider, provider)
        )
      )
      .limit(1);
    if (!row) {
      return NOT_CONFIGURED;
    }
    return { configured: true, hint: row.keyHint, updatedAt: row.updatedAt };
  };

  /**
   * Whether the provider accepts the key. A check that could not run (an
   * outage, a rate limit) is not a verdict on the key, so it is its own refusal.
   */
  const accepted = async (
    provider: ModelProvider,
    apiKey: string
  ): Promise<boolean> => {
    if (!validate) {
      return true;
    }
    try {
      return await validate(provider, apiKey);
    } catch {
      // biome-ignore lint/style/useErrorCause: a failed request can quote the key, so the error stays out.
      throw new ServiceError(
        "invalid",
        `Could not check that key with ${PROVIDER_NAMES[provider]}. Try again later.`
      );
    }
  };

  /** The status the caller may see: its own workspace's, never the key. */
  const status = async (
    principal: Principal,
    provider: ModelProvider
  ): Promise<ModelKeyStatus> => {
    const workspaceId = readableWorkspace(principal, READ_ACTION);
    authorize(principal, READ_ACTION, { kind: KEY_KIND, workspaceId });
    return await statusOf(workspaceId, provider);
  };

  /** Stores a new key, or replaces the old one for the provider. */
  const set = async (
    principal: Principal,
    input: { provider: ModelProvider; apiKey: string }
  ): Promise<ModelKeyStatus> => {
    const user = requireUser(principal, WRITE_ACTION);
    const { workspaceId } = user;
    authorize(user, WRITE_ACTION, { kind: KEY_KIND, workspaceId });

    const { provider } = input;
    const apiKey = input.apiKey.trim();
    checkShape(apiKey);
    // Before the key leaves for the provider: a missing secretsKey fails here.
    const key = await cryptoKey();
    if (!(await accepted(provider, apiKey))) {
      throw new ServiceError(
        "invalid",
        `${PROVIDER_NAMES[provider]} did not accept that key`
      );
    }

    const now = clock.now().toISOString();
    const apiKeyEnc = await encryptSecret(
      key,
      binding(workspaceId, provider),
      apiKey
    );
    const keyHint = apiKey.slice(-HINT_LENGTH);
    await db
      .insert(workspaceModelKeys)
      .values({
        apiKeyEnc,
        createdAt: now,
        keyHint,
        provider,
        setBy: user.userId,
        updatedAt: now,
        workspaceId,
      })
      .onConflictDoUpdate({
        set: {
          apiKeyEnc,
          keyHint,
          setBy: user.userId,
          updatedAt: now,
        },
        target: [workspaceModelKeys.workspaceId, workspaceModelKeys.provider],
      });
    return await statusOf(workspaceId, provider);
  };

  /** Removes the key for the provider. Idempotent. */
  const remove = async (
    principal: Principal,
    provider: ModelProvider
  ): Promise<ModelKeyStatus> => {
    const user = requireUser(principal, WRITE_ACTION);
    const { workspaceId } = user;
    authorize(user, WRITE_ACTION, { kind: KEY_KIND, workspaceId });

    await db
      .delete(workspaceModelKeys)
      .where(
        and(
          eq(workspaceModelKeys.workspaceId, workspaceId),
          eq(workspaceModelKeys.provider, provider)
        )
      );
    return NOT_CONFIGURED;
  };

  /** The decrypted key for the gateway. Null when the workspace has none for the provider. */
  const resolve = async (
    workspaceId: string,
    provider: ModelProvider
  ): Promise<{ apiKey: string } | null> => {
    const [row] = await db
      .select({ apiKeyEnc: workspaceModelKeys.apiKeyEnc })
      .from(workspaceModelKeys)
      .where(
        and(
          eq(workspaceModelKeys.workspaceId, workspaceId),
          eq(workspaceModelKeys.provider, provider)
        )
      )
      .limit(1);
    if (!row) {
      return null;
    }
    const apiKey = await decryptSecret(
      await cryptoKey(),
      binding(workspaceId, provider),
      row.apiKeyEnc
    );
    return { apiKey };
  };

  return { remove, resolve, set, status };
};

export type ModelKeysService = ReturnType<typeof createModelKeysService>;
