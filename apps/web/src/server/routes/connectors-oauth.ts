// The browser half of connecting a connector with OAuth: `GET /connect/:id`
// sends a signed-in person to the provider, and `GET /api/connectors/oauth/callback`
// brings them back. Both authenticate with the Clerk session cookie only, so
// the services can bind the flow to the person who clicked. Answers are plain
// text for a refusal and redirects otherwise, because a browser navigates here.
// Mount with `accessRoutes.route("/", connectorOAuthRoutes({ session }))`,
// because the paths are full, not prefixed.

import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import type { Principal } from "@repo/services/workspaces";
import type { Context } from "hono";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import type { AppEnv } from "./groups.ts";

const BAD_REQUEST = 400;
const FOUND = 302;
const FORBIDDEN = 403;
const UNAUTHORIZED = 401;

export interface ConnectorOAuthRouteDeps {
  /** The Clerk session of the request: its user and active org, or null. */
  session: (
    c: Context<AppEnv>
  ) => { orgId?: string | null; userId: string | null } | null;
}

type RouteContext = Context<AppEnv>;

type Caller =
  | { kind: "none" }
  | { kind: "no_workspace" }
  | { kind: "user"; principal: Principal };

const caller = async (
  c: RouteContext,
  deps: ConnectorOAuthRouteDeps
): Promise<Caller> => {
  const session = deps.session(c);
  if (!session?.userId) {
    return { kind: "none" };
  }
  const principal = await c
    .get("composed")
    .services.workspaces.sessionPrincipal({
      orgId: session.orgId,
      userId: session.userId,
    });
  return principal ? { kind: "user", principal } : { kind: "no_workspace" };
};

/** A refusal the services raised, as a plain page. Anything else is a bug and rethrows. */
const refusal = (c: RouteContext, error: unknown): Response => {
  if (isForbiddenError(error)) {
    return c.text("Not allowed.", FORBIDDEN);
  }
  if (error instanceof ZodError) {
    return c.text("That request is malformed.", BAD_REQUEST);
  }
  if (isServiceError(error)) {
    return c.text(error.message, error.status as ContentfulStatusCode);
  }
  throw error;
};

const noStore = (c: RouteContext): void => {
  c.header("Cache-Control", "no-store");
};

export const connectorOAuthRoutes = (
  deps: ConnectorOAuthRouteDeps
): Hono<AppEnv> => {
  const routes = new Hono<AppEnv>();

  routes.get("/connect/:connectorId", async (c) => {
    noStore(c);
    const who = await caller(c, deps);
    if (who.kind === "none") {
      return c.redirect("/login", FOUND);
    }
    if (who.kind === "no_workspace") {
      return c.text("Not allowed.", FORBIDDEN);
    }
    try {
      const { authorizeUrl } = await c
        .get("composed")
        .services.connectorOAuth.start(who.principal, {
          as: c.req.query("as") ?? "user",
          connectorId: c.req.param("connectorId"),
          origin: new URL(c.req.url).origin,
          returnTo: c.req.query("return_to"),
        });
      return c.redirect(authorizeUrl, FOUND);
    } catch (error: unknown) {
      return refusal(c, error);
    }
  });

  routes.get("/api/connectors/oauth/callback", async (c) => {
    noStore(c);
    const who = await caller(c, deps);
    if (who.kind !== "user") {
      return c.text("Sign in, then start again from Connect.", UNAUTHORIZED);
    }
    const state = c.req.query("state");
    if (!state) {
      return c.text("The provider sent no state.", BAD_REQUEST);
    }
    try {
      const result = await c
        .get("composed")
        .services.connectorOAuth.complete(who.principal, {
          code: c.req.query("code"),
          error:
            c.req.query("error_description") ??
            c.req.query("error") ??
            undefined,
          state,
        });
      return c.redirect(result.returnTo, FOUND);
    } catch (error: unknown) {
      return refusal(c, error);
    }
  });

  return routes;
};
