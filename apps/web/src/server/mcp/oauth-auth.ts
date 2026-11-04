// Clerk OAuth access token to the claim the principal resolver takes. Clerk's
// tokens carry no audience, so a valid token only proves the user consented to
// SOME app on the Clerk instance. This is where an app is held back until a
// workspace member approves its client (the oauth_clients row for that client
// and workspace). The workspace is the one the MCP address names
// (`/mcp/<workspaceId>`), or for bare `/mcp` the user's home workspace. A
// client is recorded in a workspace only for a member of its organisation.
// The resolver then checks the user's org membership on every request.
import type {
  OAuthClientResolution,
  OAuthClientsService,
} from "@repo/services/oauth-clients";
import type {
  createWorkspacesService,
  VerifiedOAuthClaim,
} from "@repo/services/workspaces";
import type { OrgMemberCheck, UserOrgsCheck } from "./clerk-membership.ts";
import type { VerifiedOAuthToken } from "./clerk-oauth.ts";

/** Why a valid Clerk token is still refused with a 403. */
export type OAuthDeniedReason =
  | "no_workspace"
  | "not_member"
  | "pending"
  | "revoked";

/** The token is Clerk's, but the app is not approved, or the user has no workspace here. */
export class OAuthDeniedError extends Error {
  readonly clientId: string;
  readonly reason: OAuthDeniedReason;
  readonly userId: string;

  constructor(reason: OAuthDeniedReason, clientId: string, userId: string) {
    super(`OAuth client ${clientId} refused: ${reason}`);
    this.name = "OAuthDeniedError";
    this.clientId = clientId;
    this.reason = reason;
    this.userId = userId;
  }
}

/** The workspace an MCP address names: its id and its Clerk organisation. */
export interface TargetWorkspace {
  clerkOrgId: string;
  id: string;
}

export interface OAuthClaimDeps {
  /** The OAuth application's name, looked up only when its client is first seen. */
  clientName: (clientId: string) => Promise<string | null>;
  /** Whether the user belongs to the organisation, for a workspace the address names. */
  isOrgMember: OrgMemberCheck;
  oauthClients: Pick<OAuthClientsService, "resolve">;
  /** The workspace the address names (`/mcp/<id>`); null for bare `/mcp`, the home workspace. */
  target: TargetWorkspace | null;
  /** The organisations Clerk lists for the user: one call, however many workspaces exist. */
  userOrgIds: UserOrgsCheck;
  /** Clerk's verdict on the token: null when it is no valid OAuth access token. */
  verify: (token: string) => Promise<VerifiedOAuthToken | null>;
  workspaces: Pick<ReturnType<typeof createWorkspacesService>, "firstForOrgs">;
}

/**
 * The user's home workspace: the oldest workspace among their organisations.
 * Null when they have none, so a stranger on a shared Clerk instance, or a
 * member of an organisation with no workspace row, cannot put clients in
 * anyone's queue.
 */
const homeWorkspaceId = async (
  deps: OAuthClaimDeps,
  userId: string
): Promise<string | null> => {
  const workspace = await deps.workspaces.firstForOrgs(
    await deps.userOrgIds(userId)
  );
  return workspace ? workspace.id : null;
};

/**
 * The workspace the request acts in. A workspace the address names needs the
 * user's membership before anything is recorded there.
 */
const workspaceFor = async (
  deps: OAuthClaimDeps,
  token: VerifiedOAuthToken
): Promise<string> => {
  if (deps.target) {
    if (!(await deps.isOrgMember(token.userId, deps.target.clerkOrgId))) {
      throw new OAuthDeniedError("not_member", token.clientId, token.userId);
    }
    return deps.target.id;
  }
  const home = await homeWorkspaceId(deps, token.userId);
  if (home === null) {
    throw new OAuthDeniedError("no_workspace", token.clientId, token.userId);
  }
  return home;
};

const claimOf = (
  resolution: OAuthClientResolution,
  token: VerifiedOAuthToken,
  workspaceId: string
): VerifiedOAuthClaim => {
  if (resolution.status !== "approved") {
    throw new OAuthDeniedError(resolution.status, token.clientId, token.userId);
  }
  return {
    access: resolution.access,
    clientId: token.clientId,
    userId: token.userId,
    workspaceId,
  };
};

/**
 * `verifyClerkOAuthToken` for the principal resolver: null for a token Clerk
 * does not vouch for, a claim for a client approved in the request's
 * workspace, an `OAuthDeniedError` for a pending or revoked one or a user who
 * may not act there. A Clerk outage throws, like any other error.
 */
export const oauthClaimVerifier =
  (deps: OAuthClaimDeps) =>
  async (token: string): Promise<VerifiedOAuthClaim | null> => {
    const verified = await deps.verify(token);
    if (!verified) {
      return null;
    }
    const workspaceId = await workspaceFor(deps, verified);
    const resolution = await deps.oauthClients.resolve({
      clientId: verified.clientId,
      name: () => deps.clientName(verified.clientId),
      userId: verified.userId,
      workspaceId,
    });
    return claimOf(resolution, verified, workspaceId);
  };
