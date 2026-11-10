// The response shapes the bearer and cookie routes share: a JSON error, a
// service refusal, the 401 challenge and the user behind a Clerk session.

import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import type { Principal } from "@repo/services/workspaces";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "./groups.ts";

type UserPrincipal = Extract<Principal, { kind: "user" }>;

const FORBIDDEN = 403;
const UNAUTHORIZED = 401;

export const jsonError = (
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  error: string
) => c.json({ error }, status);

/**
 * What a service refused with, as a JSON response. A forbidden error never
 * says why. Anything else is a bug and rethrows.
 */
export const serviceRefusal = (
  c: Context<AppEnv>,
  error: unknown
): Response => {
  if (isForbiddenError(error)) {
    return jsonError(c, FORBIDDEN, "Not allowed.");
  }
  if (isServiceError(error)) {
    return jsonError(c, error.status as ContentfulStatusCode, error.message);
  }
  throw error;
};

/** The `WWW-Authenticate` value (RFC 6750) with the realm and any extra parameters. */
export const bearerChallenge = (extra: readonly string[] = []): string =>
  `Bearer ${['realm="agentum"', ...extra].join(", ")}`;

/** A bearer 401 with a JSON error code and its challenge. */
export const bearerUnauthorized = (
  error = "unauthorized",
  extraParams: readonly string[] = []
): Response =>
  Response.json(
    { error },
    {
      headers: { "WWW-Authenticate": bearerChallenge(extraParams) },
      status: UNAUTHORIZED,
    }
  );

/**
 * The 401 for a request that carried a token (`invalid_token`, RFC 6750) or
 * none. The extra parameters come before `error`.
 */
export const tokenUnauthorized = (
  hadToken: boolean,
  extraParams: readonly string[] = []
): Response =>
  hadToken
    ? bearerUnauthorized("invalid_token", [
        ...extraParams,
        'error="invalid_token"',
      ])
    : bearerUnauthorized("unauthorized", extraParams);

export interface SessionDeps {
  /** The Clerk session of the request: its user and active org, or null. */
  session: (
    c: Context<AppEnv>
  ) => { orgId?: string | null; userId: string | null } | null;
}

/**
 * The principal behind the Clerk session cookie, or null when there is no
 * signed-in user or the active organisation has no workspace row.
 */
export const sessionUser = async (
  c: Context<AppEnv>,
  deps: SessionDeps
): Promise<UserPrincipal | null> => {
  const session = deps.session(c);
  if (!session?.userId) {
    return null;
  }
  return await c.get("composed").services.workspaces.sessionPrincipal({
    orgId: session.orgId,
    userId: session.userId,
  });
};
