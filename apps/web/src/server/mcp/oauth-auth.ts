// Clerk OAuth access token to the claim the principal resolver takes. Clerk's
// tokens carry no audience, so a valid token only proves the user consented to
// SOME app on the Clerk instance. This is where an app is held back until a
// workspace member approves its client (the oauth_clients row), and where the
// approved row, never the request, picks the workspace the caller acts in.
// The resolver then checks the user's org membership on every request.
import type {
  OAuthClientResolution,
  OAuthClientsService,
} from "@repo/services/oauth-clients";
import type {
  createWorkspacesService,
  VerifiedOAuthClaim,
} from "@repo/services/workspaces";
import type { UserOrgsCheck } from "./clerk-membership.ts";
import type { VerifiedOAuthToken } from "./clerk-oauth.ts";

/** Why a valid Clerk token is still refused with a 403. */
export type OAuthDeniedReason = "no_workspace" | "pending" | "revoked";

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

export interface OAuthClaimDeps {
  /** The OAuth application's name, looked up only when its client is first seen. */
  clientName: (clientId: string) => Promise<string | null>;
  oauthClients: Pick<OAuthClientsService, "resolve">;
  /** The organisations Clerk lists for the user: one call, however many workspaces exist. */
  userOrgIds: UserOrgsCheck;
  /** Clerk's verdict on the token: null when it is no valid OAuth access token. */
  verify: (token: string) => Promise<VerifiedOAuthToken | null>;
  workspaces: Pick<ReturnType<typeof createWorkspacesService>, "firstForOrgs">;
}

/**
 * The workspace a new client is recorded in: the oldest workspace among the
 * user's organisations. Null when they have none, so a stranger on a shared
 * Clerk instance, or a member of an organisation with no workspace row,
 * cannot put clients in anyone's queue.
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

const claimOf = (
  resolution: OAuthClientResolution,
  token: VerifiedOAuthToken
): VerifiedOAuthClaim => {
  if (resolution.status !== "approved") {
    throw new OAuthDeniedError(resolution.status, token.clientId, token.userId);
  }
  return {
    access: resolution.access,
    clientId: token.clientId,
    userId: token.userId,
    workspaceId: resolution.workspaceId,
  };
};

/**
 * `verifyClerkOAuthToken` for the principal resolver: null for a token Clerk
 * does not vouch for, a claim for an approved client, an `OAuthDeniedError`
 * for a pending or revoked one. A Clerk outage throws, like any other error.
 */
export const oauthClaimVerifier =
  (deps: OAuthClaimDeps) =>
  async (token: string): Promise<VerifiedOAuthClaim | null> => {
    const verified = await deps.verify(token);
    if (!verified) {
      return null;
    }
    const resolution = await deps.oauthClients.resolve({
      clientId: verified.clientId,
      homeWorkspaceId: () => homeWorkspaceId(deps, verified.userId),
      name: () => deps.clientName(verified.clientId),
      userId: verified.userId,
    });
    return claimOf(resolution, verified);
  };
