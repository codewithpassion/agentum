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
import type { ApiKeyAccess, OAuthClientAccess } from "@repo/db/shared";
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { ForbiddenError } from "./authz.ts";
import { hashToken } from "./crypto.ts";
import { ServiceError } from "./errors.ts";
import {
  RUN_TOKEN_PREFIX,
  SESSION_TOKEN_PREFIX,
  verifyAgentToken,
} from "./run-tokens.ts";

/** Who is calling. `system` is the minute tick, in-process only. */
export type Principal =
  | {
      /** Set when `via` is `api_key`: which key, and what it may do. */
      apiKey?: { access: ApiKeyAccess; id: string; name?: string };
      /** Set on a session: the person is an admin of the Clerk organisation. Only an admin mints an admin key. */
      isAdmin?: boolean;
      kind: "user";
      /** Set when `via` is `oauth`: which client, and what it may do. */
      oauthClient?: { access: OAuthClientAccess; clientId: string };
      workspaceId: string;
      userId: string;
      via: "session" | "api_key" | "oauth" | "slack";
    }
  | {
      kind: "run";
      workspaceId: string;
      runId: string;
      agentId: string;
      /** Set when the run is a dry run: it reads and thinks, and skips every write. Absent means false. */
      dryRun?: boolean;
      /** Derived from the stored run by bearer authentication, never token claims. */
      scopeArtifactId?: string;
    }
  | { kind: "machine"; workspaceId: string; machineId: string }
  | {
      kind: "trigger";
      workspaceId: string;
      triggerId: string;
      agentId: string;
    }
  | {
      kind: "peer";
      workspaceId: string;
      connectionId: string;
      agentId: string;
      /**
       * Hops so far, read by the `/a2a` route from the message's metadata and
       * set on the principal after `authenticate`, which has no body to read.
       * Absent means 0. Never trusted past `MAX_RUN_DEPTH`.
       */
      hops?: number;
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

/** The Clerk side of making a workspace: an organisation, and undoing it. */
export interface OrganizationsPort {
  /** Makes the organisation with `createdBy` as its admin, and turns off admin delete on it. */
  create: (input: {
    createdBy: string;
    name: string;
  }) => Promise<{ id: string }>;
  /**
   * Sends an organisation invitation by email. `redirectUrl` is where the
   * invitee lands after the email link. Returns a status instead of throwing
   * for the two conflicts a person can fix: the address already belongs to a
   * member, or already has a pending invitation.
   */
  invite: (input: {
    clerkOrgId: string;
    emailAddress: string;
    inviterUserId: string;
    redirectUrl: string;
    role: InviteRole;
  }) => Promise<"already_invited" | "already_member" | "invited">;
  /** Deletes an organisation. */
  remove: (clerkOrgId: string) => Promise<void>;
}

/** The roles `inviteFromSession` hands out: the Clerk roles `Member` and `Admin`. */
export const INVITE_ROLES = ["org:member", "org:admin"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

const EMAIL_SCHEMA = z.email();

/** Where an invitation email sends the invitee, under `PUBLIC_BASE_URL`. */
export const ACCEPT_INVITATION_PATH = "/accept-invitation";

/** One organisation a person belongs to, and their Clerk role in it. */
export interface UserOrganization {
  clerkOrgId: string;
  role: string;
}

/** The longest workspace name `createFromSession` accepts. */
export const MAX_WORKSPACE_NAME_LENGTH = 80;

/** The Clerk role of an organisation admin. */
const ADMIN_ORG_ROLE = "org:admin";

/** How long a membership answer is reused, in milliseconds. */
const MEMBERSHIP_TTL_MS = 60_000;

/**
 * Workspace access by Clerk org. An org has access exactly when a `workspaces`
 * row carries its id, and only `create` makes a row. `orgName` reads the
 * organisation's name from Clerk; null means Clerk has none.
 */
export const createWorkspacesService = ({
  db,
  orgName,
  organizations,
  publicBaseUrl,
  userOrganizations,
}: {
  db: Database;
  orgName?: (clerkOrgId: string) => Promise<string | null>;
  /** Makes and deletes Clerk organisations. Without it, `createFromSession` is unavailable. */
  organizations?: OrganizationsPort;
  /** `PUBLIC_BASE_URL`. Invitation links land under it. Without it, `inviteFromSession` is unavailable. */
  publicBaseUrl?: string;
  /** Lists the organisations Clerk says a person belongs to. Without it, `mine` is empty. */
  userOrganizations?: (userId: string) => Promise<UserOrganization[]>;
}) => {
  const selectRow = async (clerkOrgId: string) => {
    const [row] = await db
      .select(WORKSPACE_COLUMNS)
      .from(workspaces)
      .where(eq(workspaces.clerkOrgId, clerkOrgId))
      .limit(1);
    return row;
  };

  /**
   * The Clerk name for an org, or null. A failed lookup is null too: the name
   * is cosmetic, so a Clerk outage must not fail the request, and the next
   * request tries again.
   */
  const lookupName = async (clerkOrgId: string): Promise<string | null> => {
    if (!orgName) {
      return null;
    }
    try {
      return (await orgName(clerkOrgId))?.trim() || null;
    } catch {
      return null;
    }
  };

  /**
   * The workspace row for `clerkOrgId`, or null when it has none: this never
   * creates one. A row whose name still equals its org id is looked up again
   * and renamed once Clerk has a name, or to `name` when the caller has one.
   */
  const forOrg = async ({
    clerkOrgId,
    name,
  }: {
    clerkOrgId: string;
    name?: string;
  }): Promise<Workspace | null> => {
    const row = await selectRow(clerkOrgId);
    if (!row || row.name !== clerkOrgId) {
      return row ?? null;
    }
    const resolved = name ?? (await lookupName(clerkOrgId));
    if (!resolved || resolved === row.name) {
      return row;
    }
    await db
      .update(workspaces)
      .set({ name: resolved })
      .where(eq(workspaces.clerkOrgId, clerkOrgId));
    return (await selectRow(clerkOrgId)) ?? row;
  };

  /**
   * Makes the workspace for `clerkOrgId`, or returns the one it has. For
   * system callers only: the add-workspace script and the create-workspace
   * screen. A request never reaches this on its own, so an organisation made
   * anywhere else on the Clerk instance gets no workspace.
   */
  const create = async ({
    clerkOrgId,
    name,
  }: {
    clerkOrgId: string;
    name: string;
  }): Promise<Workspace> => {
    // Two concurrent calls both insert; the unique clerk_org_id keeps one.
    await db
      .insert(workspaces)
      .values({
        clerkOrgId,
        createdAt: new Date().toISOString(),
        id: ulid(),
        name: name.trim() || clerkOrgId,
        timezone: "UTC",
      })
      .onConflictDoNothing();
    const row = await selectRow(clerkOrgId);
    if (!row) {
      throw new Error(`Workspace for ${clerkOrgId} is missing after insert.`);
    }
    return row;
  };

  /**
   * The oldest workspace whose org is one of `clerkOrgIds`, or null. The
   * OAuth path uses it with the orgs Clerk lists for the user, so it needs
   * one Clerk call however many workspaces exist.
   */
  const firstForOrgs = async (
    clerkOrgIds: readonly string[]
  ): Promise<Workspace | null> => {
    if (clerkOrgIds.length === 0) {
      return null;
    }
    const [row] = await db
      .select(WORKSPACE_COLUMNS)
      .from(workspaces)
      .where(inArray(workspaces.clerkOrgId, [...clerkOrgIds]))
      .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
      .limit(1);
    return row ?? null;
  };

  /**
   * The user principal for a Clerk session. Clerk signs the org claim, so
   * there is no membership call here. Null without an org, or when the org
   * has no workspace row.
   */
  const sessionPrincipal = async ({
    orgId,
    orgRole,
    userId,
  }: {
    orgId: string | null | undefined;
    orgRole?: string | null;
    userId: string;
  }): Promise<Extract<Principal, { kind: "user" }> | null> => {
    if (!orgId) {
      return null;
    }
    const workspace = await forOrg({ clerkOrgId: orgId });
    return workspace
      ? {
          isAdmin: orgRole === ADMIN_ORG_ROLE,
          kind: "user",
          userId,
          via: "session",
          workspaceId: workspace.id,
        }
      : null;
  };

  /**
   * A new workspace made by an org admin on a browser session: the Clerk
   * organisation first, with the caller as its admin, then the row. A failed
   * row deletes the organisation again, so a retry starts clean.
   */
  const createFromSession = async (
    principal: Principal,
    input: { name: string }
  ): Promise<Workspace> => {
    if (
      principal.kind !== "user" ||
      principal.via !== "session" ||
      principal.isAdmin !== true
    ) {
      throw new ForbiddenError("create a workspace");
    }
    const name = input.name.trim();
    if (name.length === 0 || name.length > MAX_WORKSPACE_NAME_LENGTH) {
      throw new ServiceError(
        "invalid",
        `A workspace name is 1 to ${MAX_WORKSPACE_NAME_LENGTH} characters.`
      );
    }
    if (!organizations) {
      throw new Error(
        "Creating workspaces needs the Clerk organisations port."
      );
    }
    const { id } = await organizations.create({
      createdBy: principal.userId,
      name,
    });
    try {
      return await create({ clerkOrgId: id, name });
    } catch (error) {
      await organizations.remove(id).catch(() => undefined);
      throw error;
    }
  };

  /**
   * Invites a person to the caller's workspace by email, from a browser
   * session of an org admin. The organisation comes from the principal's
   * workspace, never from the client. The email link lands on
   * `/accept-invitation` of this deployment, carrying the organisation id so
   * the new member's session can make it active.
   */
  const inviteFromSession = async (
    principal: Principal,
    input: { email: string; role: InviteRole }
  ): Promise<{ email: string }> => {
    if (
      principal.kind !== "user" ||
      principal.via !== "session" ||
      principal.isAdmin !== true
    ) {
      throw new ForbiddenError("invite people");
    }
    const parsed = EMAIL_SCHEMA.safeParse(input.email.trim());
    if (!parsed.success) {
      throw new ServiceError("invalid", "Enter a valid email address.");
    }
    const emailAddress = parsed.data;
    if (!INVITE_ROLES.includes(input.role)) {
      throw new ServiceError("invalid", "Choose Member or Admin.");
    }
    if (!publicBaseUrl) {
      throw new ServiceError(
        "invalid",
        "Invitations are not set up on this deployment."
      );
    }
    if (!organizations) {
      throw new Error("Inviting people needs the Clerk organisations port.");
    }
    const [row] = await db
      .select({ clerkOrgId: workspaces.clerkOrgId })
      .from(workspaces)
      .where(eq(workspaces.id, principal.workspaceId))
      .limit(1);
    if (!row) {
      throw new ServiceError("not_found", "Workspace not found.");
    }
    const redirectUrl = new URL(ACCEPT_INVITATION_PATH, publicBaseUrl);
    redirectUrl.searchParams.set("org", row.clerkOrgId);
    const status = await organizations.invite({
      clerkOrgId: row.clerkOrgId,
      emailAddress,
      inviterUserId: principal.userId,
      redirectUrl: redirectUrl.toString(),
      role: input.role,
    });
    if (status === "already_member") {
      throw new ServiceError(
        "conflict",
        `${emailAddress} is already a member of this workspace.`
      );
    }
    if (status === "already_invited") {
      throw new ServiceError(
        "conflict",
        `${emailAddress} already has a pending invitation.`
      );
    }
    return { email: emailAddress };
  };

  /**
   * The workspaces a person can switch to: their Clerk memberships that have
   * a row, with their role in each. Works whether or not the session's active
   * organisation has a row. An organisation without a row, such as another
   * app's on a shared Clerk instance, is left out.
   */
  const mine = async (
    userId: string
  ): Promise<{ clerkOrgId: string; role: string; workspaceId: string }[]> => {
    const memberships = userOrganizations
      ? await userOrganizations(userId)
      : [];
    if (memberships.length === 0) {
      return [];
    }
    const rows = await db
      .select({ clerkOrgId: workspaces.clerkOrgId, id: workspaces.id })
      .from(workspaces)
      .where(
        inArray(
          workspaces.clerkOrgId,
          memberships.map((membership) => membership.clerkOrgId)
        )
      )
      .orderBy(asc(workspaces.createdAt), asc(workspaces.id));
    const roles = new Map(
      memberships.map((membership) => [membership.clerkOrgId, membership.role])
    );
    return rows.map((row) => ({
      clerkOrgId: row.clerkOrgId,
      role: roles.get(row.clerkOrgId) ?? "",
      workspaceId: row.id,
    }));
  };

  return {
    create,
    createFromSession,
    firstForOrgs,
    forOrg,
    inviteFromSession,
    mine,
    sessionPrincipal,
  };
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

/** The trigger principal for an `hm_trg_` token, or null if unknown, revoked or paused. */
export const findTriggerByToken = async (
  db: Database,
  token: string
): Promise<Extract<Principal, { kind: "trigger" }> | null> => {
  const [row] = await db
    .select({
      agentId: triggers.agentId,
      id: triggers.id,
      workspaceId: triggers.workspaceId,
    })
    .from(triggers)
    .where(
      and(
        eq(triggers.tokenHash, await hashToken(token)),
        isNull(triggers.revokedAt),
        isNull(triggers.disabledAt)
      )
    )
    .limit(1);
  return row
    ? {
        agentId: row.agentId,
        kind: "trigger",
        triggerId: row.id,
        workspaceId: row.workspaceId,
      }
    : null;
};

/** What the app's Clerk OAuth check hands the resolver for a token it accepts. */
export interface VerifiedOAuthClaim {
  access: OAuthClientAccess;
  clientId: string;
  userId: string;
  workspaceId: string;
}

export interface PrincipalResolverOptions {
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
    const result = await verifyAgentToken({ db, key: runTokenKey, token });
    if (!result.ok) {
      return null;
    }
    const { agentId, runId, workspaceId } = result.claims;
    return {
      agentId,
      dryRun: result.dryRun,
      ...(result.scopeArtifactId
        ? { scopeArtifactId: result.scopeArtifactId }
        : {}),
      kind: "run",
      runId,
      workspaceId,
    } as const;
  };

  const lookupApiKey = async (token: string) => {
    const [row] = await db
      .select({
        access: apiKeys.access,
        createdBy: apiKeys.createdBy,
        id: apiKeys.id,
        name: apiKeys.name,
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
          apiKey: { access: row.access, id: row.id, name: row.name },
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
    [SESSION_TOKEN_PREFIX, lookupRun],
    ["hm_mach_", (token) => findMachineByCredential(db, token)],
    ["hm_trg_", (token) => findTriggerByToken(db, token)],
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

  /** The workspace row for `workspaceId`, or null when there is none. */
  const workspaceRow = async (workspaceId: string) => {
    const [row] = await db
      .select(WORKSPACE_COLUMNS)
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    return row ?? null;
  };

  /**
   * A user candidate needs its org membership. The workspace row is loaded
   * first, so a workspace with no row never reaches Clerk.
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
    const workspace = await workspaceRow(candidate.workspaceId);
    if (!workspace) {
      return null;
    }
    return (await passesMembership(candidate, workspace.clerkOrgId))
      ? candidate
      : null;
  };

  return { resolve };
};
