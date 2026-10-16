/**
 * Workspaces and principals (contract C2). A workspace is one Clerk
 * organisation. A principal is who is calling, resolved from a Clerk session
 * or a bearer token.
 */
import type { Database } from "@repo/db";
import { apiKeys } from "@repo/db/schema/api-keys";
import { machines } from "@repo/db/schema/machines";
import { triggers } from "@repo/db/schema/triggers";
import { workspaces } from "@repo/db/schema/workspaces";
import type { ApiKeyAccess } from "@repo/db/shared";
import { and, eq, isNull, ne } from "drizzle-orm";
import { ulid } from "ulidx";
import { hashToken } from "./crypto.ts";
import { RUN_TOKEN_PREFIX, verifyRunToken } from "./run-tokens.ts";

/** Who is calling. `system` is the minute tick, in-process only. */
export type Principal =
  | {
      /** Set when `via` is `api_key`: which key, and what it may do. */
      apiKey?: { access: ApiKeyAccess; id: string };
      kind: "user";
      /** Set when `via` is `oauth`: which client, and what it may do. */
      oauthClient?: { access: ApiKeyAccess; clientId: string };
      workspaceId: string;
      userId: string;
      via: "session" | "api_key" | "oauth";
    }
  | { kind: "run"; workspaceId: string; runId: string; agentId: string }
  | { kind: "machine"; workspaceId: string; machineId: string }
  | {
      kind: "trigger";
      workspaceId: string;
      triggerId: string;
      agentId: string;
    }
  | { kind: "system" };

/** Every principal except `system`: the ones that act inside one workspace. */
export type WorkspacePrincipal = Exclude<Principal, { kind: "system" }>;

/** The principal the minute tick passes in-process. Nothing resolves to it from a request. */
export const SYSTEM_PRINCIPAL: Principal = { kind: "system" };

/** A workspace row as the services hand it out. */
export interface Workspace {
  clerkOrgId: string;
  id: string;
  name: string;
  timezone: string;
}

const WORKSPACE_COLUMNS = {
  clerkOrgId: workspaces.clerkOrgId,
  id: workspaces.id,
  name: workspaces.name,
  timezone: workspaces.timezone,
};

/** How long a membership answer is reused, in milliseconds. */
const MEMBERSHIP_TTL_MS = 60_000;

/**
 * Workspace access by Clerk org. `allowedOrgIds` is the set of orgs this
 * deployment serves; an org outside it has no workspace here.
 */
export const createWorkspacesService = ({
  allowedOrgIds,
  db,
}: {
  allowedOrgIds: readonly string[];
  db: Database;
}) => {
  /**
   * The workspace for `clerkOrgId`, created on the first call. Null when the
   * org is not in `allowedOrgIds`. `name` only applies when the row is created.
   */
  const forOrg = async ({
    clerkOrgId,
    name,
  }: {
    clerkOrgId: string;
    name?: string;
  }): Promise<Workspace | null> => {
    if (!allowedOrgIds.includes(clerkOrgId)) {
      return null;
    }
    // Two concurrent first calls both insert; the unique clerk_org_id keeps one.
    await db
      .insert(workspaces)
      .values({
        clerkOrgId,
        createdAt: new Date().toISOString(),
        id: ulid(),
        name: name ?? clerkOrgId,
        timezone: "UTC",
      })
      .onConflictDoNothing();
    const [row] = await db
      .select(WORKSPACE_COLUMNS)
      .from(workspaces)
      .where(eq(workspaces.clerkOrgId, clerkOrgId))
      .limit(1);
    if (!row) {
      throw new Error(`Workspace for ${clerkOrgId} is missing after insert.`);
    }
    return row;
  };

  /**
   * The user principal for a Clerk session. Clerk signs the org claim, so
   * there is no membership call here. Null without an org or outside
   * `allowedOrgIds`.
   */
  const sessionPrincipal = async ({
    orgId,
    userId,
  }: {
    orgId: string | null | undefined;
    userId: string;
  }): Promise<Extract<Principal, { kind: "user" }> | null> => {
    if (!orgId) {
      return null;
    }
    const workspace = await forOrg({ clerkOrgId: orgId });
    return workspace
      ? { kind: "user", userId, via: "session", workspaceId: workspace.id }
      : null;
  };

  return { forOrg, sessionPrincipal };
};

/** The machine principal for an `hm_mach_` credential, or null if unknown or revoked. */
export const findMachineByCredential = async (
  db: Database,
  token: string
): Promise<Extract<Principal, { kind: "machine" }> | null> => {
  const [row] = await db
    .select({ id: machines.id, workspaceId: machines.workspaceId })
    .from(machines)
    .where(
      and(
        eq(machines.credentialHash, await hashToken(token)),
        ne(machines.status, "revoked")
      )
    )
    .limit(1);
  return row
    ? { kind: "machine", machineId: row.id, workspaceId: row.workspaceId }
    : null;
};

/** What the app's Clerk OAuth check hands the resolver for a token it accepts. */
export interface VerifiedOAuthClaim {
  access: ApiKeyAccess;
  clientId: string;
  userId: string;
  workspaceId: string;
}

export interface PrincipalResolverOptions {
  allowedOrgIds: readonly string[];
  db: Database;
  /** Whether `userId` is a member of the Clerk org right now. Errors propagate. */
  isOrgMember: (userId: string, clerkOrgId: string) => Promise<boolean>;
  /** Epoch milliseconds. Used only by the membership cache. */
  now?: () => number;
  runTokenKey: CryptoKey;
  /**
   * Verifies a Clerk OAuth token and returns the user, and the client's
   * access and workspace from its approved oauth_clients row. The app's
   * implementation does that lookup. The workspace never comes from the
   * request. Errors propagate.
   */
  verifyClerkOAuthToken: (token: string) => Promise<VerifiedOAuthClaim | null>;
}

const BEARER_SCHEME = "bearer";
const HM_PREFIX = "hm_";

/**
 * The token in `Authorization: Bearer <token>`, or null. The scheme is case
 * insensitive. Exactly one space separates it from the token, and the token
 * has no spaces.
 */
export const bearerToken = (authorization: string | null): string | null => {
  if (!authorization) {
    return null;
  }
  const [scheme, token, ...rest] = authorization.split(" ");
  if (rest.length > 0 || scheme?.toLowerCase() !== BEARER_SCHEME || !token) {
    return null;
  }
  return token;
};

/**
 * Turns the Authorization header into a principal, or null. Used at every
 * request edge. A token that does not check out is null, which the edge
 * answers with 401. An error from `isOrgMember` or `verifyClerkOAuthToken`
 * is not caught, so a Clerk outage fails the request instead of answering 401.
 */
export const createPrincipalResolver = ({
  allowedOrgIds,
  db,
  isOrgMember,
  now = Date.now,
  runTokenKey,
  verifyClerkOAuthToken,
}: PrincipalResolverOptions) => {
  const membership = new Map<string, { member: boolean; expiresAt: number }>();

  /** `isOrgMember`, cached for 60 seconds per user and org, true and false alike. */
  const isMember = async (userId: string, clerkOrgId: string) => {
    const key = `${userId}\n${clerkOrgId}`;
    const current = now();
    const hit = membership.get(key);
    if (hit && hit.expiresAt > current) {
      return hit.member;
    }
    const member = await isOrgMember(userId, clerkOrgId);
    membership.set(key, { expiresAt: current + MEMBERSHIP_TTL_MS, member });
    return member;
  };

  const lookupRun = async (token: string) => {
    const result = await verifyRunToken({ db, key: runTokenKey, token });
    if (!result.ok) {
      return null;
    }
    const { agentId, runId, workspaceId } = result.claims;
    return { agentId, kind: "run", runId, workspaceId } as const;
  };

  const lookupTrigger = async (token: string) => {
    const [row] = await db
      .select({
        agentId: triggers.agentId,
        id: triggers.id,
        workspaceId: triggers.workspaceId,
      })
      .from(triggers)
      .where(eq(triggers.tokenHash, await hashToken(token)))
      .limit(1);
    return row
      ? {
          agentId: row.agentId,
          kind: "trigger" as const,
          triggerId: row.id,
          workspaceId: row.workspaceId,
        }
      : null;
  };

  const lookupApiKey = async (token: string) => {
    const [row] = await db
      .select({
        access: apiKeys.access,
        createdBy: apiKeys.createdBy,
        id: apiKeys.id,
        workspaceId: apiKeys.workspaceId,
      })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.keyHash, await hashToken(token)),
          isNull(apiKeys.revokedAt)
        )
      )
      .limit(1);
    return row
      ? {
          apiKey: { access: row.access, id: row.id },
          kind: "user" as const,
          userId: row.createdBy,
          via: "api_key" as const,
          workspaceId: row.workspaceId,
        }
      : null;
  };

  /** Lookups by token prefix. Any other `hm_` token, such as `hm_enr_`, is refused. */
  const lookupsByPrefix: ReadonlyArray<
    readonly [string, (token: string) => Promise<WorkspacePrincipal | null>]
  > = [
    [RUN_TOKEN_PREFIX, lookupRun],
    ["hm_mach_", (token) => findMachineByCredential(db, token)],
    ["hm_trg_", lookupTrigger],
    ["hm_key_", lookupApiKey],
  ];

  const lookupHmToken = (token: string) => {
    const match = lookupsByPrefix.find(([prefix]) => token.startsWith(prefix));
    return match ? match[1](token) : Promise.resolve(null);
  };

  const lookupClerkToken = async (token: string) => {
    const claim = await verifyClerkOAuthToken(token);
    return claim
      ? {
          kind: "user" as const,
          oauthClient: { access: claim.access, clientId: claim.clientId },
          userId: claim.userId,
          via: "oauth" as const,
          workspaceId: claim.workspaceId,
        }
      : null;
  };

  /** The workspace row for `workspaceId`, if its org is in `allowedOrgIds`. */
  const allowedWorkspace = async (workspaceId: string) => {
    const [row] = await db
      .select(WORKSPACE_COLUMNS)
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    return row && allowedOrgIds.includes(row.clerkOrgId) ? row : null;
  };

  /**
   * A user candidate needs its org membership. The workspace row is loaded
   * first, so a disallowed org never reaches Clerk.
   */
  const passesMembership = async (
    candidate: WorkspacePrincipal,
    clerkOrgId: string
  ) =>
    candidate.kind !== "user" || (await isMember(candidate.userId, clerkOrgId));

  /** The principal for `authorization`, or null. Never `system`. */
  const resolve = async (
    authorization: string | null
  ): Promise<Principal | null> => {
    const token = bearerToken(authorization);
    if (!token) {
      return null;
    }
    const candidate = token.startsWith(HM_PREFIX)
      ? await lookupHmToken(token)
      : await lookupClerkToken(token);
    if (!candidate) {
      return null;
    }
    const workspace = await allowedWorkspace(candidate.workspaceId);
    if (!workspace) {
      return null;
    }
    return (await passesMembership(candidate, workspace.clerkOrgId))
      ? candidate
      : null;
  };

  return { resolve };
};
