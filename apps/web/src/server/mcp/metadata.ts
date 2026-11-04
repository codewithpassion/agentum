// OAuth discovery for the MCP endpoint. Agentum is only the
// resource server; Clerk is the authorization server. These are the pure
// parts: which origin the documents describe, the Clerk issuer, the protected
// resource metadata (RFC 9728) and a small cached proxy of Clerk's own
// authorization server metadata (RFC 8414) for clients on older spec versions.
import { readCappedBody } from "./body.ts";

/** Hosts that serve the dev server. */
export const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
export const AUTH_SERVER_METADATA_PATH =
  "/.well-known/oauth-authorization-server";

/**
 * Scopes an MCP client asks Clerk for. Clerk puts the user id in every access
 * token (`subject`) whatever the scopes, and the email comes from the
 * allowlist check, so these only shape Clerk's userinfo payload: the least
 * that still reads as "who you are". Clients request exactly this list
 * (plus `offline_access` for a refresh token, which they add themselves), so
 * an OAuth application must allow at least these.
 */
export const OAUTH_SCOPES = ["profile", "email"] as const;

/** How long a fetched authorization server document is served from memory. */
export const AUTH_SERVER_METADATA_TTL_MS = 5 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 5000;
/** Largest upstream document accepted; Clerk's is about 2 KB. */
export const MAX_AUTH_SERVER_METADATA_BYTES = 64 * 1024;
const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

/**
 * The origin (scheme, host, port) the metadata describes: the one the MCP
 * client connected to, or it rejects the documents.
 *
 * - The request's host is PUBLIC_BASE_URL's host: PUBLIC_BASE_URL (right
 *   scheme behind a proxy).
 * - A dev build and the request came to a local dev host: the request's own
 *   origin, so dev works whatever PUBLIC_BASE_URL says.
 * - Otherwise PUBLIC_BASE_URL, and null without one. A Host header is never
 *   reflected in production.
 */
export const mcpOrigin = (
  requestUrl: string,
  options: {
    dev: boolean;
    forwardedProto?: string | null;
    publicBaseUrl: string | undefined;
  }
): string | null => {
  const request = new URL(requestUrl);
  const configured = options.publicBaseUrl
    ? new URL(options.publicBaseUrl)
    : null;
  if (configured && configured.host === request.host) {
    return configured.origin;
  }
  if (options.dev && LOCAL_HOSTNAMES.includes(request.hostname)) {
    const proto =
      options.forwardedProto === "https" || options.forwardedProto === "http"
        ? `${options.forwardedProto}:`
        : request.protocol;
    return `${proto}//${request.host}`;
  }
  return configured ? configured.origin : null;
};

/** The MCP path every workspace shares; its home-workspace address. */
export const MCP_ROUTE = "/mcp";

/**
 * The shape a workspace id in an MCP address must have before anything looks
 * it up: ULIDs in production, short ids in tests. No `/`, `.` or `%`.
 */
const WORKSPACE_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/** Whether `segment` may be a workspace id; the database decides if it is one. */
export const isWorkspaceIdShape = (segment: string): boolean =>
  WORKSPACE_ID_SHAPE.test(segment);

/** The MCP path of a workspace's own address. */
export const workspaceMcpRoute = (workspaceId: string): string =>
  `${MCP_ROUTE}/${workspaceId}`;

/** Where the protected resource metadata for an MCP path lives on `origin` (RFC 9728 3.1). */
export const resourceMetadataUrl = (origin: string, route: string): string =>
  `${origin}${PROTECTED_RESOURCE_PATH}${route}`;

export type IssuerResult =
  | { issuer: string; ok: true }
  | { message: string; ok: false };

const PUBLISHABLE_KEY = /^pk_(test|live)_([A-Za-z0-9+/=]+)$/;

/**
 * Clerk's Frontend API origin, which is its OAuth issuer, from the base64
 * tail of the publishable key (`<host>$`). Null for anything else.
 */
export const issuerFromPublishableKey = (
  publishableKey: string | undefined
): string | null => {
  const encoded = PUBLISHABLE_KEY.exec(publishableKey ?? "")?.[2];
  if (!encoded) {
    return null;
  }
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return null;
  }
  if (!decoded.endsWith("$")) {
    return null;
  }
  const host = decoded.slice(0, -1);
  try {
    const url = new URL(`https://${host}`);
    return url.host === host ? url.origin : null;
  } catch {
    return null;
  }
};

/** The Clerk issuer, derived from the publishable key. */
export const resolveIssuer = (
  publishableKey: string | undefined
): IssuerResult => {
  const issuer = issuerFromPublishableKey(publishableKey);
  return issuer
    ? { issuer, ok: true }
    : {
        message: "CLERK_PUBLISHABLE_KEY does not encode a Clerk host",
        ok: false,
      };
};

/** RFC 9728 protected resource metadata for the MCP endpoint at `origin`. */
export const protectedResourceMetadata = (options: {
  issuer: string;
  origin: string;
  route: string;
}) => ({
  authorization_servers: [options.issuer],
  bearer_methods_supported: ["header"],
  resource: `${options.origin}${options.route}`,
  resource_name: "Agentum",
  scopes_supported: [...OAUTH_SCOPES],
});

/** Open CORS, for the `.well-known` documents only. */
export const CORS_HEADERS = {
  "Access-Control-Allow-Headers": "Accept, MCP-Protocol-Version",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Max-Age": "86400",
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type AuthServerMetadataResult =
  | { document: Record<string, unknown>; ok: true }
  | { message: string; ok: false };

/**
 * Fetches `<issuer>/.well-known/oauth-authorization-server` and keeps a good
 * answer in memory for `ttlMs`. The answer must have a JSON content type and
 * at most 64 KB, or it is a failure (the route answers 502). A failure is
 * never cached, and an expired entry is never served: the next request
 * fetches again.
 */
export const createAuthServerMetadataProxy = (
  options: { fetch?: typeof fetch; now?: () => number; ttlMs?: number } = {}
) => {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? AUTH_SERVER_METADATA_TTL_MS;
  const cache = new Map<
    string,
    { document: Record<string, unknown>; expiresAt: number }
  >();

  return async (issuer: string): Promise<AuthServerMetadataResult> => {
    const cached = cache.get(issuer);
    if (cached && cached.expiresAt > now()) {
      return { document: cached.document, ok: true };
    }
    cache.delete(issuer);
    let response: Response;
    try {
      response = await fetchFn(`${issuer}${AUTH_SERVER_METADATA_PATH}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      return {
        message: error instanceof Error ? error.message : String(error),
        ok: false,
      };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { message: `upstream answered ${response.status}`, ok: false };
    }
    if (!JSON_CONTENT_TYPE.test(response.headers.get("Content-Type") ?? "")) {
      await response.body?.cancel();
      return {
        message: "upstream answered without a JSON content type",
        ok: false,
      };
    }
    let document: unknown;
    try {
      const body = await readCappedBody(
        response,
        MAX_AUTH_SERVER_METADATA_BYTES
      );
      if (!body.ok) {
        return { message: "upstream document is too large", ok: false };
      }
      document = JSON.parse(new TextDecoder().decode(body.bytes)) as unknown;
    } catch {
      return { message: "upstream answered with invalid JSON", ok: false };
    }
    if (!isRecord(document) || document.issuer !== issuer) {
      return {
        message: "upstream document does not name the expected issuer",
        ok: false,
      };
    }
    cache.set(issuer, { document, expiresAt: now() + ttlMs });
    return { document, ok: true };
  };
};
