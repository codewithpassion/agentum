/**
 * API keys: `hm_key_` secrets a user mints for the MCP endpoint. The secret
 * is shown once, at creation. The table keeps only its SHA-256, so nothing
 * here can hand a secret back. `touch` records a use at most every five
 * minutes, so a busy agent does not turn every request into a write.
 */
import type { Database } from "@repo/db";
import { apiKeys } from "@repo/db/schema/api-keys";
import { API_KEY_ACCESS, type ApiKeyAccess } from "@repo/db/shared";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { authorize, ForbiddenError } from "./authz.ts";
import { hashedToken } from "./crypto.ts";
import { ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import type { Clock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

export const API_KEY_PREFIX = "hm_key_";
/** Characters of the random part shown back to the owner, so keys can be told apart. */
const HINT_LENGTH = 4;
/** `last_used_at` is rewritten only once its stored value is this old. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

const API_KEY_KIND = "api_key";
const CREATE_ACTION = "api_keys.create";
const LIST_ACTION = "api_keys.list";
const REVOKE_ACTION = "api_keys.revoke";

type UserPrincipal = Extract<Principal, { kind: "user" }>;

export const apiKeyCreateInputSchema = z.strictObject({
  access: z.enum(API_KEY_ACCESS),
  name: z.string().trim().min(1).max(80),
});
type ApiKeyCreateInput = z.input<typeof apiKeyCreateInputSchema>;

/** An API key as its owner may see it. Never carries the hash. */
export interface ApiKeySummary {
  access: ApiKeyAccess;
  createdAt: string;
  id: string;
  lastUsedAt: string | null;
  name: string;
  prefix: string;
  revokedAt: string | null;
}

const summaryColumns = {
  access: apiKeys.access,
  createdAt: apiKeys.createdAt,
  id: apiKeys.id,
  lastUsedAt: apiKeys.lastUsedAt,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  revokedAt: apiKeys.revokedAt,
};

/** Keys are managed from a signed-in session: a key cannot mint or revoke keys. */
const requireUser = (principal: Principal, action: string): UserPrincipal => {
  if (principal.kind !== "user" || principal.via !== "session") {
    throw new ForbiddenError(action);
  }
  return principal;
};

export const createApiKeysService = ({
  clock,
  db,
  events,
}: {
  clock: Clock;
  db: Database;
  events: EventsService;
}) => {
  /** A new key for the calling user. The returned `secret` is the only copy. */
  const create = async (
    principal: Principal,
    input: ApiKeyCreateInput
  ): Promise<{ key: ApiKeySummary; secret: string }> => {
    const user = requireUser(principal, CREATE_ACTION);
    const { access, name } = apiKeyCreateInputSchema.parse(input);
    authorize(user, CREATE_ACTION, {
      kind: API_KEY_KIND,
      workspaceId: user.workspaceId,
    });
    const now = clock.now();
    const { hash, token } = await hashedToken(API_KEY_PREFIX);
    const key: ApiKeySummary = {
      access,
      createdAt: now.toISOString(),
      id: ulid(now.getTime()),
      lastUsedAt: null,
      name,
      prefix: token.slice(0, API_KEY_PREFIX.length + HINT_LENGTH),
      revokedAt: null,
    };
    await db.insert(apiKeys).values({
      access: key.access,
      createdAt: key.createdAt,
      createdBy: user.userId,
      id: key.id,
      keyHash: hash,
      name: key.name,
      prefix: key.prefix,
      workspaceId: user.workspaceId,
    });
    await events.append({
      actor: { id: user.userId, kind: "user" },
      payload: { access, keyId: key.id, name },
      type: "api_key.created",
      workspaceId: user.workspaceId,
    });
    return { key, secret: token };
  };

  /** The calling user's keys in their workspace, newest first, revoked ones included. */
  const list = async (principal: Principal): Promise<ApiKeySummary[]> => {
    const user = requireUser(principal, LIST_ACTION);
    authorize(user, LIST_ACTION, {
      kind: API_KEY_KIND,
      workspaceId: user.workspaceId,
    });
    return await db
      .select(summaryColumns)
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.createdBy, user.userId),
          eq(apiKeys.workspaceId, user.workspaceId)
        )
      )
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
  };

  /**
   * Revokes one of the calling user's keys. A key already revoked keeps its
   * first timestamp: the update only matches rows with `revoked_at` null.
   */
  const revoke = async (
    principal: Principal,
    keyId: string
  ): Promise<ApiKeySummary> => {
    const user = requireUser(principal, REVOKE_ACTION);
    authorize(user, REVOKE_ACTION, {
      id: keyId,
      kind: API_KEY_KIND,
      workspaceId: user.workspaceId,
    });
    const owned = and(
      eq(apiKeys.id, keyId),
      eq(apiKeys.createdBy, user.userId),
      eq(apiKeys.workspaceId, user.workspaceId)
    );
    const [revoked] = await db
      .update(apiKeys)
      .set({ revokedAt: clock.now().toISOString() })
      .where(and(owned, isNull(apiKeys.revokedAt)))
      .returning(summaryColumns);
    if (revoked) {
      return revoked;
    }
    const [current] = await db
      .select(summaryColumns)
      .from(apiKeys)
      .where(owned)
      .limit(1);
    if (!current) {
      throw new ServiceError("not_found", "API key not found");
    }
    return current;
  };

  /**
   * Records that a key was used. Writes only when `last_used_at` is null or
   * older than five minutes, and never on a revoked key. Returns whether it
   * wrote. No principal: the caller has authenticated the key already, and
   * the write is scoped to `workspaceId`.
   */
  const touch = async (
    keyId: string,
    workspaceId: string
  ): Promise<boolean> => {
    const now = clock.now();
    const stale = new Date(now.getTime() - TOUCH_INTERVAL_MS).toISOString();
    const written = await db
      .update(apiKeys)
      .set({ lastUsedAt: now.toISOString() })
      .where(
        and(
          eq(apiKeys.id, keyId),
          eq(apiKeys.workspaceId, workspaceId),
          isNull(apiKeys.revokedAt),
          or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, stale))
        )
      )
      .returning({ id: apiKeys.id });
    return written.length > 0;
  };

  return { create, list, revoke, touch };
};

export type ApiKeysService = ReturnType<typeof createApiKeysService>;
