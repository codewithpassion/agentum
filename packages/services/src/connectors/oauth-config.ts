import { TOKEN_ENDPOINT_AUTH_METHODS } from "@repo/db/shared";
import { z } from "zod";
import type {
  AuthorizationServerMetadata,
  ProtectedResourceMetadata,
} from "./oauth.ts";

/**
 * What discovery learned about a connector's OAuth server, stored as JSON in
 * `connectors.oauth`. `client` is the OAuth client Harbourmaster uses at that
 * server: registered on the fly, or typed in by a person when the server has
 * no registration endpoint. Its secret is AES-GCM ciphertext. The whole object
 * stays on the server; the connector summary only says whether a client exists.
 */
export const oauthConfigSchema = z.object({
  authorizationEndpoint: z.string(),
  client: z
    .object({
      clientId: z.string(),
      clientSecret: z.string().nullable(),
      // The redirect URI a registered client was made for. Null for a typed one.
      redirectUri: z.string().nullable(),
      source: z.enum(["manual", "registered"]),
      tokenEndpointAuth: z.enum(TOKEN_ENDPOINT_AUTH_METHODS),
    })
    .nullable(),
  registrationEndpoint: z.string().nullable(),
  // RFC 8707 audience sent to the authorization and token endpoints.
  resource: z.string(),
  scope: z.string().nullable(),
  tokenEndpoint: z.string(),
  tokenEndpointAuthMethods: z.array(z.string()),
});
export type OAuthConfig = z.infer<typeof oauthConfigSchema>;
export type OAuthClient = NonNullable<OAuthConfig["client"]>;

/** The stored config, or null when there is none or it does not parse. */
export const parseOAuthConfig = (raw: string | null): OAuthConfig | null => {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = oauthConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** A fresh config from a discovery result, with no client yet. */
export const configFromDiscovery = (
  found: {
    metadata: AuthorizationServerMetadata;
    resource: ProtectedResourceMetadata | null;
  },
  mcpUrl: string,
  scope: string | null
): OAuthConfig => ({
  authorizationEndpoint: found.metadata.authorizationEndpoint,
  client: null,
  registrationEndpoint: found.metadata.registrationEndpoint,
  resource: found.resource?.resource ?? mcpUrl,
  scope,
  tokenEndpoint: found.metadata.tokenEndpoint,
  tokenEndpointAuthMethods: found.metadata.tokenEndpointAuthMethods,
});
