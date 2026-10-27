import { createClerkClient } from "@clerk/backend";
import { type Principal, SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import type { Composed } from "../compose";
import { clerkOrgMemberCheckFresh } from "../mcp/clerk-membership";
import { clerkOAuthVerifier } from "../mcp/clerk-oauth";
import { clerkOAuthClientName } from "../mcp/clerk-oauth-client";
import { authenticateBearer } from "../mcp/principal-resolver";
import { requiredLive } from "./required";

export const freshMember = async (
  env: Env,
  composed: Composed,
  workspaceId: string,
  userId: string
) => {
  const orgId = await requiredLive(composed.services).roomOrgId(
    SYSTEM_PRINCIPAL,
    workspaceId
  );
  if (
    !(
      orgId &&
      env.ALLOWED_ORG_IDS.split(",")
        .map((s) => s.trim())
        .includes(orgId)
    )
  ) {
    return null;
  }
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  const memberships = await clerk.users.getOrganizationMembershipList({
    limit: 100,
    userId,
  });
  const membership = memberships.data.find((m) => m.organization.id === orgId);
  if (!membership) {
    return null;
  }
  return composed.services.workspaces.sessionPrincipal({
    orgId,
    orgRole: membership.role,
    userId,
  });
};

/** Replays the original credential through its real verifier; claims never
 * substitute for a credential. The stored reference is private to the room. */
export const authenticateRoomRequest = async (
  env: Env,
  composed: Composed,
  request: Request
): Promise<Principal | null> => {
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  if (request.headers.has("Authorization")) {
    return authenticateBearer(
      { composed, env },
      {
        clientName: (e) => clerkOAuthClientName(e.CLERK_SECRET_KEY),
        isOrgMember: (e) => clerkOrgMemberCheckFresh(e.CLERK_SECRET_KEY),
        verifyOAuthToken: () =>
          clerkOAuthVerifier({
            verify: (token) => clerk.idPOAuthAccessToken.verify(token),
          }),
      },
      request.headers.get("Authorization")
    );
  }
  if (!request.headers.has("Cookie")) {
    return null;
  }
  const result = await clerk.authenticateRequest(request);
  const auth = result.toAuth();
  if (!(auth?.userId && auth.orgId && auth.sessionId)) {
    return null;
  }
  const session = await clerk.sessions.getSession(auth.sessionId);
  if (session.status !== "active" || session.expireAt <= Date.now()) {
    return null;
  }
  const principal = await composed.services.workspaces.sessionPrincipal({
    orgId: auth.orgId,
    orgRole: auth.orgRole,
    userId: auth.userId,
  });
  return principal
    ? freshMember(env, composed, principal.workspaceId, principal.userId)
    : null;
};
