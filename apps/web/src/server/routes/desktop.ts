// A signed-in person's view of a machine's desktop: its status, the clipboard
// and the viewer WebSocket. `:id` is a machine id. The services decide who may
// see the computer (`requireComputer`), and the relay decides the lease on the
// signed-in person, never on anything the client sent. Mount with
// `runtimeRoutes.route("/api/machines/:id/desktop", desktopRoutes({ session }))`.

import {
  DesktopClipboardGetResultPayloadSchema,
  DesktopClipboardTextSchema,
} from "@repo/protocol/computer";
import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import type { Principal } from "@repo/services/workspaces";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { relayFailure } from "../desktop-failure.ts";
import {
  RELAY_HEADER_MACHINE_ID,
  RELAY_HEADER_ROLE,
  RELAY_HEADER_VIEWER_USER,
  RELAY_HEADER_WORKSPACE_ID,
} from "../relay-core.ts";
import { desktopStatusBody } from "../viewer-hub.ts";
import { type AppEnv, cookieGroup } from "./groups.ts";
import { UPGRADE_HEADERS } from "./machines.ts";

const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const NO_WORKSPACE = 403;
const UNAUTHORIZED = 401;
const UPGRADE_REQUIRED = 426;
const BAD_GATEWAY = 502;

export interface DesktopRouteDeps {
  /** The Clerk session of the request: its user and active org, or null. */
  session: (
    c: Context<AppEnv>
  ) => { orgId?: string | null; userId: string | null } | null;
}

type RouteContext = Context<AppEnv>;
type UserPrincipal = Extract<Principal, { kind: "user" }>;

const ClipboardBodySchema = z.object({ text: DesktopClipboardTextSchema });

const parseJson = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

/** The machine a `/:id` route names. The mount path guarantees the id is there. */
const machineIdOf = (c: RouteContext): string => {
  const id = c.req.param("id");
  if (!id) {
    throw new Error("A route under /:id has no machine id.");
  }
  return id;
};

/**
 * A refusal the services raised, as JSON. Anything else is a bug and rethrows.
 * A machine another workspace owns, a revoked one and one without a computer
 * all reach here as `not_found`, so the caller cannot tell them apart.
 */
const refusal = (c: RouteContext, error: unknown): Response => {
  if (isForbiddenError(error)) {
    return c.json({ error: "forbidden", message: error.message }, FORBIDDEN);
  }
  if (isServiceError(error)) {
    return c.json(
      { error: error.code, message: error.message },
      error.status as ContentfulStatusCode
    );
  }
  throw error;
};

/** Resolves the Clerk session to a workspace user, or answers why it cannot. */
const caller = async (
  c: RouteContext,
  deps: DesktopRouteDeps
): Promise<UserPrincipal | Response> => {
  const session = deps.session(c);
  if (!session?.userId) {
    return c.json({ error: "unauthorized" }, UNAUTHORIZED);
  }
  const principal = await c
    .get("composed")
    .services.workspaces.sessionPrincipal({
      orgId: session.orgId,
      userId: session.userId,
    });
  if (!principal) {
    return c.json({ error: "no_workspace" }, NO_WORKSPACE);
  }
  return principal;
};

type Handler = (
  c: RouteContext,
  principal: UserPrincipal,
  machineId: string
) => Promise<Response>;

/** Runs a route for a signed-in user, and maps the refusals the services raise. */
const signedIn =
  (deps: DesktopRouteDeps, handler: Handler) =>
  async (c: RouteContext): Promise<Response> => {
    const who = await caller(c, deps);
    if (who instanceof Response) {
      return who;
    }
    try {
      return await handler(c, who, machineIdOf(c));
    } catch (error: unknown) {
      return refusal(c, error);
    }
  };

const noStore = (c: RouteContext): void => {
  c.header("Cache-Control", "no-store");
};

export const desktopRoutes = (deps: DesktopRouteDeps): Hono<AppEnv> => {
  const routes = cookieGroup();

  routes.get(
    "/",
    signedIn(deps, async (c, principal, machineId) => {
      const status = await c
        .get("composed")
        .services.machines.desktopStatus(principal, machineId);
      return c.json(desktopStatusBody(status, principal.userId));
    })
  );

  routes.get(
    "/clipboard",
    signedIn(deps, async (c, principal, machineId) => {
      noStore(c);
      const outcome = await c
        .get("composed")
        .services.machines.clipboardRead(principal, machineId);
      if (!outcome.ok) {
        const failure = relayFailure(outcome);
        return c.json(
          { error: failure.error, message: failure.message },
          failure.status
        );
      }
      const payload = DesktopClipboardGetResultPayloadSchema.safeParse(
        parseJson(outcome.resultJson)
      );
      if (!payload.success) {
        return c.json(
          {
            error: "desktop_failed",
            message:
              "The computer sent a reply this server cannot read. Check that its version matches this deployment.",
          },
          BAD_GATEWAY
        );
      }
      return c.json({ text: payload.data.text });
    })
  );

  routes.put(
    "/clipboard",
    signedIn(deps, async (c, principal, machineId) => {
      const body = ClipboardBodySchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!body.success) {
        return c.json(
          { error: "bad_request", message: "Expected JSON with a text field." },
          BAD_REQUEST
        );
      }
      const outcome = await c
        .get("composed")
        .services.machines.clipboardWrite(principal, machineId, body.data.text);
      if (!outcome.ok) {
        const failure = relayFailure(outcome);
        return c.json(
          { error: failure.error, message: failure.message },
          failure.status
        );
      }
      return c.body(null, 204);
    })
  );

  routes.get(
    "/stream",
    signedIn(deps, async (c, principal, machineId) => {
      if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
        return c.json(
          {
            error: "upgrade_required",
            message: "Expected a WebSocket upgrade.",
          },
          UPGRADE_REQUIRED
        );
      }
      // Cookies ride along on a WebSocket from any site, and this socket can
      // drive the desktop, so only this app's own origin may open it.
      const origin = c.req.header("Origin");
      if (origin === undefined || origin !== new URL(c.req.url).origin) {
        return c.json(
          { error: "forbidden", message: "Cross-origin request refused." },
          FORBIDDEN
        );
      }
      await c
        .get("composed")
        .services.machines.requireComputer(principal, machineId);
      const headers = new Headers();
      for (const name of UPGRADE_HEADERS) {
        const value = c.req.header(name);
        if (value !== undefined) {
          headers.set(name, value);
        }
      }
      // Set from the session, so a client cannot spoof them.
      headers.set(RELAY_HEADER_MACHINE_ID, machineId);
      headers.set(RELAY_HEADER_WORKSPACE_ID, principal.workspaceId);
      headers.set(RELAY_HEADER_ROLE, "viewer");
      headers.set(RELAY_HEADER_VIEWER_USER, principal.userId);
      const stub = c.env.MACHINE_RELAY.get(
        c.env.MACHINE_RELAY.idFromName(machineId)
      );
      return stub.fetch(new Request(c.req.url, { headers, method: "GET" }));
    })
  );

  return routes;
};
