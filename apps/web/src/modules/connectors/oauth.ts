import type { TokenEndpointAuthMethod } from "./schema";
import { assertSafeUrl } from "./url";

/**
 * The "no preset list" ladder: everything needed to get from a pasted MCP URL
 * to a token, using only what the server advertises about itself.
 *
 * - RFC 9728 protected-resource metadata, found through the `WWW-Authenticate`
 *   challenge or the well-known path.
 * - RFC 8414 authorization-server metadata.
 * - RFC 7591 dynamic client registration, when the server offers it.
 * - RFC 7636 authorization code + PKCE (S256), with the RFC 8707 `resource`
 *   parameter the MCP spec requires.
 *
 * Every URL that comes out of a discovery document is pushed back through
 * `assertSafeUrl` before it is fetched: metadata is server-controlled input.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const VERIFIER_BYTES = 32;
const STATE_BYTES = 32;
const BASE64_PAD = /[=]+$/;
const QUOTED = /^"(.*)"$/;
const TRAILING_SLASH = /\/$/;
const AUTH_PARAM = /([a-z_]+)\s*=\s*("[^"]*"|[^\s,]+)/gi;
const SECONDS = 1000;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const ERROR_SNIPPET_LENGTH = 300;

export class OAuthDiscoveryError extends Error {}
export class OAuthTokenError extends Error {}

export interface OAuthFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

// --- small primitives -------------------------------------------------------

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(BASE64_PAD, "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
};

const randomToken = (bytes: number): string =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));

export const generateVerifier = (): string => randomToken(VERIFIER_BYTES);
export const generateState = (): string => randomToken(STATE_BYTES);

/** S256: the only challenge method worth supporting, and the one MCP mandates. */
export const challengeFor = async (verifier: string): Promise<string> =>
  toBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    )
  );

const getJson = async (
  url: string,
  options: OAuthFetchOptions
): Promise<Record<string, unknown> | null> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(assertSafeUrl(url).toString(), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  }).catch(() => null);

  if (!response?.ok) {
    return null;
  }
  return (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
};

const stringField = (
  document: Record<string, unknown>,
  field: string
): string | null => {
  const value = document[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const stringArrayField = (
  document: Record<string, unknown>,
  field: string
): string[] => {
  const value = document[field];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
};

// --- step 2: discovery ------------------------------------------------------

/**
 * Pulls the parameters out of a `WWW-Authenticate: Bearer …` challenge. Only
 * `resource_metadata` matters to us, but parsing the whole thing is no harder
 * and keeps the error messages honest.
 */
export const parseWwwAuthenticate = (
  header: string | null
): Record<string, string> => {
  const params: Record<string, string> = {};
  if (!header) {
    return params;
  }
  for (const match of header.matchAll(AUTH_PARAM)) {
    const [, key, raw] = match;
    if (key && raw) {
      params[key.toLowerCase()] = raw.replace(QUOTED, "$1");
    }
  }
  return params;
};

/**
 * Well-known lookups insert the resource path before the well-known segment
 * (RFC 9728 §3.1) and fall back to the bare root, which is what most deployed
 * servers actually answer on.
 */
const wellKnownCandidates = (target: URL, suffix: string): string[] => {
  const path = target.pathname.replace(TRAILING_SLASH, "");
  const candidates = [`${target.origin}/.well-known/${suffix}${path}`];
  if (path.length > 0) {
    candidates.push(`${target.origin}/.well-known/${suffix}`);
  }
  return candidates;
};

export interface ProtectedResourceMetadata {
  authorizationServers: string[];
  resource: string | null;
  scopesSupported: string[];
}

export const discoverProtectedResource = async (
  mcpUrl: string,
  wwwAuthenticate: string | null,
  options: OAuthFetchOptions = {}
): Promise<ProtectedResourceMetadata | null> => {
  const target = assertSafeUrl(mcpUrl);
  const advertised = parseWwwAuthenticate(wwwAuthenticate).resource_metadata;
  const candidates = [
    ...(advertised ? [advertised] : []),
    ...wellKnownCandidates(target, "oauth-protected-resource"),
  ];

  for (const candidate of candidates) {
    // Sequential on purpose: this is a fallback chain, and the first hit wins.
    // biome-ignore lint/performance/noAwaitInLoops: ordered fallback, not a fan-out
    const document = await getJson(candidate, options).catch(() => null);
    if (!document) {
      continue;
    }
    return {
      authorizationServers: stringArrayField(document, "authorization_servers"),
      resource: stringField(document, "resource"),
      scopesSupported: stringArrayField(document, "scopes_supported"),
    };
  }
  return null;
};

export interface AuthorizationServerMetadata {
  authorizationEndpoint: string;
  issuer: string;
  registrationEndpoint: string | null;
  scopesSupported: string[];
  tokenEndpoint: string;
  tokenEndpointAuthMethods: string[];
}

const toAuthorizationServer = (
  document: Record<string, unknown>
): AuthorizationServerMetadata | null => {
  const authorizationEndpoint = stringField(document, "authorization_endpoint");
  const tokenEndpoint = stringField(document, "token_endpoint");
  if (!(authorizationEndpoint && tokenEndpoint)) {
    return null;
  }
  return {
    authorizationEndpoint,
    issuer: stringField(document, "issuer") ?? "",
    registrationEndpoint: stringField(document, "registration_endpoint"),
    scopesSupported: stringArrayField(document, "scopes_supported"),
    tokenEndpoint,
    tokenEndpointAuthMethods: stringArrayField(
      document,
      "token_endpoint_auth_methods_supported"
    ),
  };
};

export const discoverAuthorizationServer = async (
  issuerUrl: string,
  options: OAuthFetchOptions = {}
): Promise<AuthorizationServerMetadata | null> => {
  const issuer = assertSafeUrl(issuerUrl);
  const candidates = [
    ...wellKnownCandidates(issuer, "oauth-authorization-server"),
    ...wellKnownCandidates(issuer, "openid-configuration"),
  ];

  for (const candidate of candidates) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered fallback, not a fan-out
    const document = await getJson(candidate, options).catch(() => null);
    const metadata = document ? toAuthorizationServer(document) : null;
    if (metadata) {
      return metadata;
    }
  }
  return null;
};

/**
 * The whole of step 2, from the 401 to a usable authorization server. Falls
 * back to treating the MCP server's own origin as the issuer, which is what a
 * server that ships no protected-resource document is implicitly claiming.
 */
export const discoverAuthorization = async (
  mcpUrl: string,
  wwwAuthenticate: string | null,
  options: OAuthFetchOptions = {}
): Promise<{
  metadata: AuthorizationServerMetadata;
  resource: ProtectedResourceMetadata | null;
}> => {
  const resource = await discoverProtectedResource(
    mcpUrl,
    wwwAuthenticate,
    options
  );
  const issuers = [
    ...(resource === null ? [] : resource.authorizationServers),
    assertSafeUrl(mcpUrl).origin,
  ];

  for (const issuer of issuers) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered fallback, not a fan-out
    const metadata = await discoverAuthorizationServer(issuer, options).catch(
      () => null
    );
    if (metadata) {
      return { metadata, resource };
    }
  }
  throw new OAuthDiscoveryError(
    "This server asks for authorization but does not publish OAuth metadata. Add it with a bearer token instead, or supply a client id from its documentation."
  );
};

// --- step 3: dynamic client registration ------------------------------------

export interface RegisteredClient {
  clientId: string;
  clientSecret: string | null;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
}

/**
 * Picks how we will authenticate at the token endpoint. A public client (no
 * secret) is `none`; with a secret we follow what the server advertises, and
 * `client_secret_basic` is the RFC 6749 default when it advertises nothing.
 */
export const chooseTokenEndpointAuth = (
  hasSecret: boolean,
  supported: readonly string[]
): TokenEndpointAuthMethod => {
  if (!hasSecret) {
    return "none";
  }
  if (supported.includes("client_secret_basic")) {
    return "client_secret_basic";
  }
  if (supported.includes("client_secret_post")) {
    return "client_secret_post";
  }
  return "client_secret_basic";
};

export const registerClient = async (
  registrationEndpoint: string,
  input: {
    clientName: string;
    redirectUri: string;
    scope?: string;
    /** From the AS metadata - the registration response does not repeat it. */
    supportedAuthMethods?: readonly string[];
  },
  options: OAuthFetchOptions = {}
): Promise<RegisteredClient> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    assertSafeUrl(registrationEndpoint).toString(),
    {
      body: JSON.stringify({
        application_type: "web",
        client_name: input.clientName,
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: [input.redirectUri],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(input.scope ? { scope: input.scope } : {}),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    }
  );

  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const clientId = body ? stringField(body, "client_id") : null;
  if (!(response.ok && clientId)) {
    throw new OAuthDiscoveryError(
      "This server's dynamic client registration refused us. Supply a client id from its documentation instead."
    );
  }

  const clientSecret = stringField(body ?? {}, "client_secret");
  return {
    clientId,
    clientSecret,
    // The server has the last word: we asked for a public client, but if it
    // issued a secret it expects to see it, so honour what came back.
    tokenEndpointAuthMethod: chooseTokenEndpointAuth(
      Boolean(clientSecret),
      input.supportedAuthMethods ?? []
    ),
  };
};

// --- step 4: the authorization request --------------------------------------

export interface AuthorizeUrlInput {
  authorizationEndpoint: string;
  challenge: string;
  clientId: string;
  redirectUri: string;
  /** RFC 8707 audience restriction; the MCP spec requires the server's URL. */
  resource: string;
  scope?: string | null;
  state: string;
}

export const buildAuthorizeUrl = (input: AuthorizeUrlInput): string => {
  const url = assertSafeUrl(input.authorizationEndpoint);
  const params = url.searchParams;
  params.set("response_type", "code");
  params.set("client_id", input.clientId);
  params.set("redirect_uri", input.redirectUri);
  params.set("state", input.state);
  params.set("code_challenge", input.challenge);
  params.set("code_challenge_method", "S256");
  params.set("resource", input.resource);
  if (input.scope) {
    params.set("scope", input.scope);
  }
  return url.toString();
};

/** What the server offered, preferring the resource document over the AS. */
export const scopeFor = (
  resource: ProtectedResourceMetadata | null,
  metadata: AuthorizationServerMetadata
): string | null => {
  const advertised = resource === null ? [] : resource.scopesSupported;
  const scopes = advertised.length > 0 ? advertised : metadata.scopesSupported;
  return scopes.length > 0 ? scopes.join(" ") : null;
};

// --- step 5: the token endpoint ---------------------------------------------

export interface ClientCredentials {
  clientId: string;
  clientSecret: string | null;
  tokenEndpointAuth: TokenEndpointAuthMethod;
}

export interface OAuthTokens {
  accessToken: string;
  /** Absolute, derived from `expires_in`; servers only ever send the relative one. */
  expiresAt: Date;
  refreshToken: string | null;
  scope: string | null;
}

const applyClientAuth = (
  credentials: ClientCredentials,
  body: URLSearchParams,
  headers: Record<string, string>
): void => {
  body.set("client_id", credentials.clientId);
  if (!credentials.clientSecret) {
    return;
  }
  if (credentials.tokenEndpointAuth === "client_secret_post") {
    body.set("client_secret", credentials.clientSecret);
    return;
  }
  if (credentials.tokenEndpointAuth === "client_secret_basic") {
    const pair = `${encodeURIComponent(credentials.clientId)}:${encodeURIComponent(credentials.clientSecret)}`;
    headers.authorization = `Basic ${btoa(pair)}`;
  }
};

const postToken = async (
  tokenEndpoint: string,
  credentials: ClientCredentials,
  body: URLSearchParams,
  options: OAuthFetchOptions
): Promise<OAuthTokens> => {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  };
  applyClientAuth(credentials, body, headers);

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(assertSafeUrl(tokenEndpoint).toString(), {
    body: body.toString(),
    headers,
    method: "POST",
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    const detail =
      (payload ? stringField(payload, "error_description") : null) ??
      (payload ? stringField(payload, "error") : null) ??
      `HTTP ${response.status}`;
    throw new OAuthTokenError(
      `The authorization server refused the request: ${detail.slice(0, ERROR_SNIPPET_LENGTH)}`
    );
  }

  const accessToken = payload ? stringField(payload, "access_token") : null;
  if (!accessToken) {
    throw new OAuthTokenError(
      "The authorization server returned no access token."
    );
  }

  const expiresIn =
    typeof payload?.expires_in === "number"
      ? payload.expires_in
      : DEFAULT_EXPIRES_IN_SECONDS;

  return {
    accessToken,
    expiresAt: new Date(Date.now() + expiresIn * SECONDS),
    refreshToken: payload ? stringField(payload, "refresh_token") : null,
    scope: payload ? stringField(payload, "scope") : null,
  };
};

export const exchangeCode = (
  tokenEndpoint: string,
  credentials: ClientCredentials,
  input: {
    code: string;
    redirectUri: string;
    resource: string;
    verifier: string;
  },
  options: OAuthFetchOptions = {}
): Promise<OAuthTokens> =>
  postToken(
    tokenEndpoint,
    credentials,
    new URLSearchParams({
      code: input.code,
      code_verifier: input.verifier,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
      resource: input.resource,
    }),
    options
  );

/**
 * Refreshes the *management* copy only. The vault credential is refreshed by
 * Anthropic on its own schedule; if the server rotates refresh tokens, this is
 * the call that will start failing, and that failure must stay local.
 */
export const refreshTokens = (
  tokenEndpoint: string,
  credentials: ClientCredentials,
  input: { refreshToken: string; resource: string; scope?: string | null },
  options: OAuthFetchOptions = {}
): Promise<OAuthTokens> =>
  postToken(
    tokenEndpoint,
    credentials,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      resource: input.resource,
      ...(input.scope ? { scope: input.scope } : {}),
    }),
    options
  );
