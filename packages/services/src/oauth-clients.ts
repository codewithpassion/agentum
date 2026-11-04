/**
 * OAuth clients: the Clerk OAuth applications that reach `/mcp` on a user's
 * behalf. Approval is per workspace: one row per (client id, workspace), so
 * a client id shared by every user of an app (a CIMD URL) gets a row, and an
 * approval, in each workspace it connects to. A client does nothing in a
 * workspace until a member approves it there. The first request of an
 * unknown pair records it as pending, so the members see it in Settings. Approval, change and revoke take effect on the next
 * request, since every request reads the row. `touch` records a use at most
 * every five minutes, so a busy agent does not turn every request into a write.
 */
import type { Database } from "@repo/db";
import { oauthClients } from "@repo/db/schema/oauth-clients";
import { OAUTH_CLIENT_ACCESS, type OAuthClientAccess } from "@repo/db/shared";
import { and, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { authorize, ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import type { Clock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

/** Longest OAuth application name stored or shown, in code points. */
export const MAX_OAUTH_CLIENT_NAME_LENGTH = 100;
const WHITESPACE = /\s+/gu;
// Control and format characters: bidi overrides, zero-width joiners, etc.
const CONTROL_OR_FORMAT = /\p{C}/gu;
/** `last_used_at` is rewritten only once its stored value is this old. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
/** A nameless client's name lookup is retried at most this often per Worker isolate. */
const NAME_RETRY_INTERVAL_MS = 5 * 60 * 1000;

const OAUTH_CLIENT_KIND = "oauth_client";
const LIST_ACTION = "oauth_clients.list";
const SET_ACCESS_ACTION = "oauth_clients.set_access";
const REVOKE_ACTION = "oauth_clients.revoke";

type UserPrincipal = Extract<Principal, { kind: "user" }>;

/**
 * An application name as Flightdex stores and compares it. The name is chosen
 * by whoever registered the app, so control and format characters (which can
 * reorder or hide text) go, whitespace collapses to single spaces and the
 * result is capped. Nothing left is null.
 */
export const sanitizeOAuthClientName = (
  raw: string | null | undefined
): string | null => {
  const cleaned = (raw ?? "")
    .replace(WHITESPACE, " ")
    .replace(CONTROL_OR_FORMAT, "")
    .replace(WHITESPACE, " ")
    .trim();
  const capped = Array.from(cleaned)
    .slice(0, MAX_OAUTH_CLIENT_NAME_LENGTH)
    .join("")
    .trim();
  return capped === "" ? null : capped;
};

const clientIdSchema = z.string().min(1).max(200);

export const oauthClientSetAccessInputSchema = z.strictObject({
  access: z.enum(OAUTH_CLIENT_ACCESS),
  clientId: clientIdSchema,
});
export const oauthClientRevokeInputSchema = z.strictObject({
  clientId: clientIdSchema,
});
type OAuthClientSetAccessInput = z.input<
  typeof oauthClientSetAccessInputSchema
>;
type OAuthClientRevokeInput = z.input<typeof oauthClientRevokeInputSchema>;

export type OAuthClientStatus = "approved" | "pending" | "revoked";

/** An OAuth client as its owner sees it in Settings. */
export interface OAuthClientSummary {
  /** Null unless approved. */
  access: OAuthClientAccess | null;
  approvedAt: string | null;
  clientId: string;
  /** When the client was first seen. */
  firstSeenAt: string;
  lastUsedAt: string | null;
  /** The application's name as Clerk reported it; null if unknown. */
  name: string | null;
  revokedAt: string | null;
  status: OAuthClientStatus;
}

export type OAuthClientResolution =
  | { access: OAuthClientAccess; status: "approved" }
  | { name: string | null; status: "pending" }
  | { name: string | null; status: "revoked" };

export interface OAuthClientResolve {
  clientId: string;
  /**
   * Looks up the application's name. Called when the row is about to be
   * created, and on later requests only while the stored name is null, until a
   * lookup returns one. After a failed retry the next one waits five minutes
   * (per Worker isolate), so an unreachable name does not slow every request.
   * A stored name is never looked up again or overwritten.
   * A throw or null stores no name.
   */
  name?: () => Promise<string | null>;
  /** Clerk user id the token was issued to. */
  userId: string;
  /**
   * The workspace the request acts in. The caller has already checked the
   * user may record a client there.
   */
  workspaceId: string;
}

const columns = {
  access: oauthClients.access,
  approvedAt: oauthClients.approvedAt,
  clientId: oauthClients.clientId,
  firstSeenAt: oauthClients.createdAt,
  lastUsedAt: oauthClients.lastUsedAt,
  name: oauthClients.name,
  revokedAt: oauthClients.revokedAt,
};

type Row = Omit<OAuthClientSummary, "status">;
type StoredRow = Row & { workspaceId: string };

const statusOf = (
  row: Pick<Row, "access" | "revokedAt">
): OAuthClientStatus => {
  if (row.revokedAt) {
    return "revoked";
  }
  return row.access ? "approved" : "pending";
};

const toSummary = (row: Row): OAuthClientSummary => ({
  ...row,
  status: statusOf(row),
});

/** Keys are managed from a signed-in session: a client cannot approve or revoke clients. */
const requireUser = (principal: Principal, action: string): UserPrincipal => {
  if (principal.kind !== "user" || principal.via !== "session") {
    throw new ForbiddenError(action);
  }
  return principal;
};

/** The name from `lookup`, sanitized; null when there is no lookup or it fails. */
const lookupName = async (
  lookup: (() => Promise<string | null>) | undefined
): Promise<string | null> => {
  if (!lookup) {
    return null;
  }
  try {
    return sanitizeOAuthClientName(await lookup());
  } catch {
    return null;
  }
};

/** Most nameless clients remembered; the Clerk instance has a handful. */
const MAX_REMEMBERED_NAME_FAILURES = 1000;

/** When each nameless client's last failed name lookup ran, in epoch ms. */
export type NameLookupFailures = Map<string, number>;

/**
 * The service is built per request, so the default store is module state: it
 * lives as long as the Worker isolate, which is what the retry wait counts in.
 */
const isolateNameLookupFailures: NameLookupFailures = new Map();

export const createOAuthClientsService = ({
  clock,
  db,
  nameLookupFailures = isolateNameLookupFailures,
  publicBaseUrl,
}: {
  clock: Clock;
  db: Database;
  nameLookupFailures?: NameLookupFailures;
  /** The deployment's origin, for the MCP address shown in Settings. */
  publicBaseUrl?: string;
}) => {
  const rowOf = (clientId: string, workspaceId: string) =>
    and(
      eq(oauthClients.clientId, clientId),
      eq(oauthClients.workspaceId, workspaceId)
    );

  const find = async (
    clientId: string,
    workspaceId: string
  ): Promise<StoredRow | null> => {
    const [row] = await db
      .select({ ...columns, workspaceId: oauthClients.workspaceId })
      .from(oauthClients)
      .where(rowOf(clientId, workspaceId))
      .limit(1);
    return row ?? null;
  };

  /**
   * What the client may do in the request's workspace. No principal: it runs
   * before one exists, and the caller has checked the user's membership. An
   * unknown pair is recorded as pending in that workspace, and two first
   * requests at once agree on one row.
   */
  const resolve = async (
    input: OAuthClientResolve
  ): Promise<OAuthClientResolution> => {
    const { clientId, workspaceId } = input;
    const existing = await find(clientId, workspaceId);
    if (existing) {
      return answer(await fillMissingName(existing, input));
    }
    const name = await lookupName(input.name);
    const now = clock.now();
    await db
      .insert(oauthClients)
      .values({
        clientId,
        createdAt: now.toISOString(),
        firstSeenBy: input.userId,
        id: ulid(now.getTime()),
        name,
        workspaceId,
      })
      .onConflictDoNothing({
        target: [oauthClients.clientId, oauthClients.workspaceId],
      });
    const stored = await find(clientId, workspaceId);
    if (!stored) {
      throw new Error(`OAuth client ${clientId} missing after insert`);
    }
    return answer(stored);
  };

  /**
   * Gives a row stored without a name the looked-up one. The update is guarded
   * by `name IS NULL`, so a name stored by a concurrent resolve stays, and the
   * answer is read back from the row either way.
   */
  const fillMissingName = async (
    row: StoredRow,
    input: OAuthClientResolve
  ): Promise<StoredRow> => {
    if (row.name !== null || !input.name) {
      return row;
    }
    const nowMs = clock.now().getTime();
    const failedAt = nameLookupFailures.get(row.clientId);
    if (failedAt !== undefined && nowMs - failedAt < NAME_RETRY_INTERVAL_MS) {
      return row;
    }
    const name = await lookupName(input.name);
    if (name === null) {
      if (nameLookupFailures.size >= MAX_REMEMBERED_NAME_FAILURES) {
        nameLookupFailures.clear();
      }
      nameLookupFailures.set(row.clientId, nowMs);
      return row;
    }
    nameLookupFailures.delete(row.clientId);
    await db
      .update(oauthClients)
      .set({ name })
      .where(
        and(rowOf(row.clientId, row.workspaceId), isNull(oauthClients.name))
      );
    return (await find(row.clientId, row.workspaceId)) ?? row;
  };

  const answer = (row: StoredRow): OAuthClientResolution => {
    if (row.revokedAt) {
      return { name: row.name, status: "revoked" };
    }
    if (row.access) {
      return { access: row.access, status: "approved" };
    }
    return { name: row.name, status: "pending" };
  };

  /** The clients of the calling user's workspace, pending first, then most recently used. */
  const list = async (principal: Principal): Promise<OAuthClientSummary[]> => {
    const user = requireUser(principal, LIST_ACTION);
    authorize(user, LIST_ACTION, {
      kind: OAUTH_CLIENT_KIND,
      workspaceId: user.workspaceId,
    });
    const rows = await db
      .select(columns)
      .from(oauthClients)
      .where(eq(oauthClients.workspaceId, user.workspaceId))
      .orderBy(
        sql`case when ${oauthClients.access} is null and ${oauthClients.revokedAt} is null then 0 else 1 end`,
        desc(oauthClients.lastUsedAt),
        desc(oauthClients.createdAt),
        desc(oauthClients.id)
      );
    return rows.map(toSummary);
  };

  /**
   * Approves a client in the calling user's workspace, changes its access, or
   * re-approves a revoked one.
   */
  const setAccess = async (
    principal: Principal,
    input: OAuthClientSetAccessInput
  ): Promise<OAuthClientSummary> => {
    const user = requireUser(principal, SET_ACCESS_ACTION);
    const { access, clientId } = oauthClientSetAccessInputSchema.parse(input);
    authorize(user, SET_ACCESS_ACTION, {
      kind: OAUTH_CLIENT_KIND,
      workspaceId: user.workspaceId,
    });
    const [updated] = await db
      .update(oauthClients)
      .set({
        access,
        approvedAt: clock.now().toISOString(),
        revokedAt: null,
      })
      .where(
        and(
          eq(oauthClients.clientId, clientId),
          eq(oauthClients.workspaceId, user.workspaceId)
        )
      )
      .returning(columns);
    if (!updated) {
      throw new ServiceError("not_found", "OAuth client not found");
    }
    return toSummary(updated);
  };

  /**
   * Revokes (or denies, while pending) a client of the calling user's
   * workspace. The row stays, so the client cannot come back as new. Revoking
   * twice keeps the first timestamp.
   */
  const revoke = async (
    principal: Principal,
    input: OAuthClientRevokeInput
  ): Promise<OAuthClientSummary> => {
    const user = requireUser(principal, REVOKE_ACTION);
    const { clientId } = oauthClientRevokeInputSchema.parse(input);
    authorize(user, REVOKE_ACTION, {
      id: clientId,
      kind: OAUTH_CLIENT_KIND,
      workspaceId: user.workspaceId,
    });
    const owned = and(
      eq(oauthClients.clientId, clientId),
      eq(oauthClients.workspaceId, user.workspaceId)
    );
    const [revoked] = await db
      .update(oauthClients)
      .set({ access: null, revokedAt: clock.now().toISOString() })
      .where(and(owned, isNull(oauthClients.revokedAt)))
      .returning(columns);
    if (revoked) {
      return toSummary(revoked);
    }
    const [current] = await db
      .select(columns)
      .from(oauthClients)
      .where(owned)
      .limit(1);
    if (!current) {
      throw new ServiceError("not_found", "OAuth client not found");
    }
    return toSummary(current);
  };

  /**
   * Records that an approved client was used. Writes only when `last_used_at`
   * is null or older than five minutes, and only on an approved client of
   * that workspace. Returns whether it wrote. No principal: the caller has
   * authenticated the token already, and the write is scoped to `workspaceId`.
   */
  const touch = async (
    clientId: string,
    workspaceId: string
  ): Promise<boolean> => {
    const now = clock.now();
    const stale = new Date(now.getTime() - TOUCH_INTERVAL_MS).toISOString();
    const written = await db
      .update(oauthClients)
      .set({ lastUsedAt: now.toISOString() })
      .where(
        and(
          eq(oauthClients.clientId, clientId),
          eq(oauthClients.workspaceId, workspaceId),
          isNotNull(oauthClients.access),
          isNull(oauthClients.revokedAt),
          or(
            isNull(oauthClients.lastUsedAt),
            lt(oauthClients.lastUsedAt, stale)
          )
        )
      )
      .returning({ clientId: oauthClients.clientId });
    return written.length > 0;
  };

  /**
   * The calling user's workspace's own MCP address, which a client connects
   * to so it acts in this workspace. `url` is null when the deployment has no
   * `PUBLIC_BASE_URL`; the page then puts `path` on its own origin.
   */
  const mcpAddress = (
    principal: Principal
  ): { path: string; url: string | null } => {
    const user = requireUser(principal, LIST_ACTION);
    authorize(user, LIST_ACTION, {
      kind: OAUTH_CLIENT_KIND,
      workspaceId: user.workspaceId,
    });
    const path = `/mcp/${user.workspaceId}`;
    return {
      path,
      url: publicBaseUrl ? `${new URL(publicBaseUrl).origin}${path}` : null,
    };
  };

  return { list, mcpAddress, resolve, revoke, setAccess, touch };
};

export type OAuthClientsService = ReturnType<typeof createOAuthClientsService>;
