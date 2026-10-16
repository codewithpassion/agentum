// The Clerk side of OAuth for `/mcp`: verifying an access token through the
// Backend API, and looking up an OAuth application's name. The token cache is
// module state so it outlives a request (the Clerk client is built per call).
import { createClerkClient } from "@clerk/backend";
import { clerkOAuthVerifier, createOAuthTokenCache } from "./clerk-oauth.ts";

/** Applications Clerk returns per page; this instance has a handful. */
const APPLICATION_PAGE = 100;

const tokenCache = createOAuthTokenCache();

/** Verifies an access token with Clerk, reusing a good answer for 60 seconds. */
export const clerkOAuthTokenVerifier = (secretKey: string) => {
  const clerk = createClerkClient({ secretKey });
  const verify = clerkOAuthVerifier({
    verify: (token) => clerk.idPOAuthAccessToken.verify(token),
  });
  return (token: string) => tokenCache.cached(token, verify);
};

/** The name of the OAuth application with this client id, or null. */
export const clerkOAuthClientName = (secretKey: string) => {
  const clerk = createClerkClient({ secretKey });
  return async (clientId: string): Promise<string | null> => {
    const { data } = await clerk.oauthApplications.list({
      limit: APPLICATION_PAGE,
    });
    return (
      data.find((application) => application.clientId === clientId)?.name ??
      null
    );
  };
};
