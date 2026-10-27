// The principal for an `Authorization: Bearer` header, shared by the bearer
// routes that take an `hm_key_` key, a run token or a Clerk OAuth token
// (`/mcp`) and the ones that take keys only (`/api/desk`, which passes an
// OAuth verifier that accepts nothing). The membership check, the OAuth client
// gate and the run token key come from the bindings of the request.
import { importRunTokenKey } from "@repo/services/run-tokens";
import {
  createPrincipalResolver,
  type Principal,
} from "@repo/services/workspaces";
import { type Composed, parseOrgIds } from "../compose.ts";
import type { OrgMemberCheck } from "./clerk-membership.ts";
import type { VerifiedOAuthToken } from "./clerk-oauth.ts";
import { oauthClaimVerifier } from "./oauth-auth.ts";

export interface BearerAuthOptions {
  /** The name of an OAuth application, asked when its client is first seen. */
  clientName: (env: Env) => (clientId: string) => Promise<string | null>;
  /** The membership check for the bindings of this request. */
  isOrgMember: (env: Env) => OrgMemberCheck;
  /** Clerk's verdict on an OAuth access token for the bindings of this request. */
  verifyOAuthToken: (
    env: Env
  ) => (token: string) => Promise<VerifiedOAuthToken | null>;
}

/** The principal for `authorization`, or null for a bad credential. Throws when auth cannot run. */
export const authenticateBearer = async (
  { composed, env }: { composed: Composed; env: Env },
  options: BearerAuthOptions,
  authorization: string | null
): Promise<Principal | null> => {
  const allowedOrgIds = parseOrgIds(env.ALLOWED_ORG_IDS);
  const resolver = createPrincipalResolver({
    allowedOrgIds,
    db: composed.db,
    isOrgMember: options.isOrgMember(env),
    runTokenKey: await importRunTokenKey(env.RUN_TOKEN_KEY),
    // Only a token that is not an `hm_` credential gets here.
    verifyClerkOAuthToken: oauthClaimVerifier({
      allowedOrgIds,
      clientName: (clientId) => options.clientName(env)(clientId),
      isOrgMember: (userId, clerkOrgId) =>
        options.isOrgMember(env)(userId, clerkOrgId),
      oauthClients: composed.services.oauthClients,
      verify: (token) => options.verifyOAuthToken(env)(token),
      workspaces: composed.services.workspaces,
    }),
  });
  const principal = await resolver.resolve(authorization);
  if (principal?.kind === "run" && principal.scopeArtifactId) {
    await composed.services.runs.authorizeScopedRun(principal, principal.runId);
  }
  return principal;
};
