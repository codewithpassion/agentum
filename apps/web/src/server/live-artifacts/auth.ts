import { createClerkClient } from "@clerk/backend";
import { GUEST_COOKIES } from "@repo/services/live-guests/security";
import { type Principal, SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import type { Composed } from "../compose";
import {
  clerkOrgMemberCheckFresh,
  clerkUserOrgIds,
} from "../mcp/clerk-membership";
import { clerkOAuthVerifier } from "../mcp/clerk-oauth";
import { clerkOAuthClientName } from "../mcp/clerk-oauth-client";
import { authenticateBearer } from "../mcp/principal-resolver";
import { requiredLive } from "./required";

/** Clerk client for request authentication. `authenticateRequest` throws on
 * deployed Workers without the publishable key. */
export const requestClerk = (env: Env) =>
  createClerkClient({
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    secretKey: env.CLERK_SECRET_KEY,
  });

export const freshMember = async (
  env: Env,
  composed: Composed,
  workspaceId: string,
  userId: string
) => {
  // The membership list is keyed by user, so it runs beside the org lookup.
  const [orgId, memberships] = await Promise.all([
    requiredLive(composed.services).roomOrgId(SYSTEM_PRINCIPAL, workspaceId),
    requestClerk(env).users.getOrganizationMembershipList({
      limit: 100,
      userId,
    }),
  ]);
  if (!orgId) {
    return null;
  }
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

/** Clerk reads the URL, method and headers, not the body. Building from the original request
 * would consume its body, and the export route authenticates again later. */
export const clerkRequest = (request: Request, cookie: string) => {
  const headers = new Headers(request.headers);
  headers.set("Cookie", cookie);
  return new Request(request.url, { headers, method: request.method });
};

/** Replays the original credential through its real verifier; claims never
 * substitute for a credential. The stored reference is private to the room.
 * `sessionId` is set for a cookie sign-in, so a caller that stores the session
 * does not authenticate the request a second time. */
export const authenticateRoomMember = async (
  env: Env,
  composed: Composed,
  request: Request
): Promise<{ principal: Principal; sessionId?: string } | null> => {
  const clerk = requestClerk(env);
  if (request.headers.has("Authorization")) {
    const principal = await authenticateBearer(
      { composed, env },
      {
        clientName: (e) => clerkOAuthClientName(e.CLERK_SECRET_KEY),
        isOrgMember: (e) => clerkOrgMemberCheckFresh(e.CLERK_SECRET_KEY),
        userOrgIds: (e) => clerkUserOrgIds(e.CLERK_SECRET_KEY),
        verifyOAuthToken: () =>
          clerkOAuthVerifier({
            verify: (token) => clerk.idPOAuthAccessToken.verify(token),
          }),
      },
      request.headers.get("Authorization")
    );
    return principal ? { principal } : null;
  }
  if (!request.headers.has("Cookie")) {
    return null;
  }
  // This ordinary member boundary ignores the guest cookie entirely. In
  // particular, a guest-only Cookie header must behave as no member cookie.
  const cookies =
    request.headers
      .get("Cookie")
      ?.split(";")
      .map((value) => value.trim())
      .filter(
        (value) => !GUEST_COOKIES.some((name) => value.startsWith(`${name}=`))
      ) ?? [];
  if (!cookies.length) {
    return null;
  }
  const result = await clerk.authenticateRequest(
    clerkRequest(request, cookies.join("; "))
  );
  const auth = result.toAuth();
  if (!(auth?.userId && auth.orgId && auth.sessionId)) {
    return null;
  }
  const { orgId, orgRole, sessionId, userId } = auth;
  // The session check and the member check do not depend on each other.
  const [session, member] = await Promise.all([
    clerk.sessions.getSession(sessionId),
    (async () => {
      const principal = await composed.services.workspaces.sessionPrincipal({
        orgId,
        orgRole,
        userId,
      });
      return principal
        ? freshMember(env, composed, principal.workspaceId, principal.userId)
        : null;
    })(),
  ]);
  if (session.status !== "active" || session.expireAt <= Date.now()) {
    return null;
  }
  return member ? { principal: member, sessionId } : null;
};

export const authenticateRoomRequest = async (
  env: Env,
  composed: Composed,
  request: Request
): Promise<Principal | null> => {
  const member = await authenticateRoomMember(env, composed, request);
  return member ? member.principal : null;
};
