// Clerk OAuth access token verification for the MCP endpoint.
//
// One direct Backend API call, `clerk.idPOAuthAccessToken.verify(token)`
// (POST /oauth_applications/access_tokens/verify). Not `authenticateRequest`:
// in @clerk/backend 3.16.8 neither it nor its `verifyOAuthToken` reads the
// `revoked` and `expired` flags of the `IdPOAuthAccessToken` Clerk answers
// with, so a revoked or expired token Clerk still knows would pass. Here:
//
// - Only a token that looks like an OAuth access token is sent at all: the
//   `oat_` prefix, or a JWT whose header `typ` is `at+jwt` (RFC 9068), the
//   same test as the SDK's unexported `isOAuthJwt`. `hm_key_`, `ak_`, `mt_`,
//   session JWTs and garbage end as invalid without a network call.
// - A 200 answer is still refused when `revoked`, `expired`, `expiration` in
//   the past, a `type` other than an OAuth access token, a subject that is
//   not a user or an empty client id.
// - Checked against Clerk on 2026-09-21: the verify endpoint's JSON for an
//   opaque `oat_` token has NO `type` field (its `object` is
//   "clerk_idp_oauth_access_token", which the SDK class drops), so a missing
//   `type` passes; only a type that names something else is refused. And its
//   `expiration` is Unix SECONDS (e.g. 1790050279), although the SDK's type
//   says milliseconds; `fromJwtPayload` does give milliseconds. Both are
//   normalised to milliseconds by size.
// - A thrown `ClerkAPIResponseError` by status: 400, 404, 422 (any other
//   4xx) mean the token is no good (401). 401 and 403 mean OUR secret key was
//   refused (the token travels in the body; the SDK reads 401 the same way):
//   unavailable, flagged `misconfigured` for a loud log. 429, 5xx and network
//   errors: unavailable (503 + Retry-After), so a client keeps its token.
//
// `createOAuthTokenCache` keeps successful verifications per isolate for up
// to 60 s, keyed by the token's SHA-256, never the token.
import { isClerkAPIResponseError } from "@clerk/backend/errors";

/** The fields of Clerk's `IdPOAuthAccessToken` this file reads. */
export interface ClerkOAuthAccessToken {
  clientId: string;
  /** Unix ms, or null. */
  expiration: number | null;
  expired: boolean;
  revoked: boolean;
  scopes: string[];
  subject: string;
  /** Absent in Clerk's answer for an opaque token (see above). */
  type?: string | null;
}

/** `clerk.idPOAuthAccessToken.verify`, injected so tests need no Clerk. */
export type VerifyClerkOAuthToken = (
  token: string
) => Promise<ClerkOAuthAccessToken>;

/** A Clerk OAuth access token Clerk vouched for. */
export interface VerifiedOAuthToken {
  /** The OAuth application (client) the user consented to. */
  clientId: string;
  /** Unix ms when the token expires, or null when Clerk gave none. */
  expiresAt: number | null;
  scopes: string[];
  /** Clerk user id (`user_...`), the token's subject. */
  userId: string;
}

const OAUTH_TOKEN_PREFIX = "oat_";
const JWT_FORMAT = /^[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+$/;
const OAUTH_JWT_TYPES = new Set(["at+jwt", "application/at+jwt"]);
/**
 * The `type` the SDK gives an OAuth JWT (`IdPOAuthAccessToken.fromJwtPayload`).
 * Clerk's JSON for an opaque token has no `type` at all.
 */
const OAUTH_TOKEN_TYPES = new Set(["oauth_token"]);
/** Below this an `expiration` is Unix seconds (it would be 2001 in ms). */
const SECONDS_LIMIT = 1e12;
const MS_PER_SECOND = 1000;

/** `expiration` in Unix ms, whether Clerk sent seconds or milliseconds. */
const expirationMs = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value < SECONDS_LIMIT ? value * MS_PER_SECOND : value;
};

/** No type (Clerk's opaque answer) or the OAuth token type; anything else is refused. */
const isOAuthType = (type: unknown): boolean =>
  type === undefined || type === null || OAUTH_TOKEN_TYPES.has(String(type));
const USER_PREFIX = "user_";
/** Longer than any token Clerk issues; anything longer is garbage. */
const MAX_TOKEN_LENGTH = 4096;

const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const TOO_MANY_REQUESTS = 429;
const CLIENT_ERROR_MAX = 499;

/** Clerk could not answer, or refused our secret key: a 503, not a bad token. */
export class OAuthVerificationUnavailableError extends Error {
  /** Clerk refused our secret key: a configuration error, logged loudly. */
  readonly misconfigured: boolean;

  constructor(message: string, misconfigured = false) {
    super(`Clerk OAuth verification failed: ${message}`);
    this.name = "OAuthVerificationUnavailableError";
    this.misconfigured = misconfigured;
  }
}

const base64UrlDecode = (segment: string): string =>
  atob(segment.replaceAll("-", "+").replaceAll("_", "/"));

/** A JWT whose header says it is an OAuth access token (RFC 9068 2.1). */
const isOAuthJwt = (token: string): boolean => {
  if (!JWT_FORMAT.test(token)) {
    return false;
  }
  try {
    const header: unknown = JSON.parse(
      base64UrlDecode(token.slice(0, token.indexOf(".")))
    );
    return (
      typeof header === "object" &&
      header !== null &&
      "typ" in header &&
      typeof header.typ === "string" &&
      OAUTH_JWT_TYPES.has(header.typ)
    );
  } catch {
    return false;
  }
};

/** Whether `token` is worth a Clerk call: an `oat_` token or an OAuth JWT. */
export const looksLikeOAuthToken = (token: string): boolean =>
  token.length <= MAX_TOKEN_LENGTH &&
  (token.startsWith(OAUTH_TOKEN_PREFIX) || isOAuthJwt(token));

/** Null for a refused token; a throw for an outage or our own bad key. */
const classifyFailure = (error: unknown): null => {
  if (isClerkAPIResponseError(error)) {
    const { status } = error;
    if (status === UNAUTHORIZED || status === FORBIDDEN) {
      throw new OAuthVerificationUnavailableError(
        `Clerk refused the secret key (status ${status})`,
        true
      );
    }
    if (
      status >= BAD_REQUEST &&
      status <= CLIENT_ERROR_MAX &&
      status !== TOO_MANY_REQUESTS
    ) {
      return null;
    }
    throw new OAuthVerificationUnavailableError(`status ${status}`);
  }
  const message = error instanceof Error ? error.name : "unknown error";
  throw new OAuthVerificationUnavailableError(`network (${message})`);
};

/**
 * `verifyOAuthToken(token)`: the verified token, null when it is not a
 * valid, live OAuth access token for a user, and a throw
 * (`OAuthVerificationUnavailableError`) when Clerk could not answer.
 */
export const clerkOAuthVerifier =
  (options: { now?: () => number; verify: VerifyClerkOAuthToken }) =>
  async (token: string): Promise<VerifiedOAuthToken | null> => {
    if (!looksLikeOAuthToken(token)) {
      return null;
    }
    let verified: ClerkOAuthAccessToken;
    try {
      verified = await options.verify(token);
    } catch (error: unknown) {
      return classifyFailure(error);
    }
    const now = (options.now ?? Date.now)();
    const expiration = expirationMs(verified.expiration);
    if (
      verified.revoked !== false ||
      verified.expired !== false ||
      (expiration !== null && expiration <= now) ||
      !isOAuthType(verified.type) ||
      !String(verified.subject).startsWith(USER_PREFIX) ||
      !verified.clientId
    ) {
      return null;
    }
    return {
      clientId: verified.clientId,
      expiresAt: expiration,
      scopes: Array.isArray(verified.scopes) ? verified.scopes : [],
      userId: verified.subject,
    };
  };

/** How long a successful verification is reused within an isolate. */
export const OAUTH_CACHE_TTL_MS = 60_000;
export const OAUTH_CACHE_MAX_ENTRIES = 500;

const encoder = new TextEncoder();

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * A per-isolate cache of successful verifications: at most `ttlMs` and never
 * past the token's own expiry, keyed by the token's SHA-256, at most
 * `maxEntries` (the oldest is dropped). Failures and outages are never
 * cached. `cached(token, verify)` wraps any verifier, so the Clerk client
 * can still be built per request.
 */
export const createOAuthTokenCache = (
  options: { maxEntries?: number; now?: () => number; ttlMs?: number } = {}
) => {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? OAUTH_CACHE_TTL_MS;
  const maxEntries = options.maxEntries ?? OAUTH_CACHE_MAX_ENTRIES;
  const entries = new Map<
    string,
    { expiresAt: number; verified: VerifiedOAuthToken }
  >();

  const cached = async (
    token: string,
    verify: (token: string) => Promise<VerifiedOAuthToken | null>
  ): Promise<VerifiedOAuthToken | null> => {
    if (!looksLikeOAuthToken(token)) {
      return verify(token);
    }
    const key = await sha256Hex(token);
    const hit = entries.get(key);
    if (hit && hit.expiresAt > now()) {
      return hit.verified;
    }
    entries.delete(key);
    const verified = await verify(token);
    if (!verified) {
      return null;
    }
    const expiresAt = Math.min(
      now() + ttlMs,
      verified.expiresAt ?? Number.POSITIVE_INFINITY
    );
    if (expiresAt > now()) {
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        entries.delete(oldest);
      }
      entries.set(key, { expiresAt, verified });
    }
    return verified;
  };

  return { cached, size: () => entries.size };
};
