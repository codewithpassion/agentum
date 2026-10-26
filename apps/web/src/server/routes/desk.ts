// The external desk API (contract C4), `/api/desk/*`. An outside app (flightdex)
// calls it from its own server with an `hm_key_` key that has the `desk` scope
// and an `X-On-Behalf-Of: <email>` header naming the member it acts for. A
// connected app's OAuth token is not a credential here: it is never sent to
// Clerk, so it cannot register a client either. The service decides who may do
// what, so this file authenticates,
// parses the body and maps what the services refuse to a status. The live
// stream is `GET /api/desk/stream`, added later. Mount with
// `accessRoutes.route("/api/desk", deskRoutes({ ... }))`.
import { isForbiddenError } from "@repo/services/authz";
import {
  deskDecisionInputSchema,
  deskMessageInputSchema,
} from "@repo/services/desk-api";
import { isServiceError } from "@repo/services/errors";
import type { Principal } from "@repo/services/workspaces";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { readCappedBody } from "../mcp/body.ts";
import {
  authenticateBearer,
  type BearerAuthOptions,
} from "../mcp/principal-resolver.ts";
import { type AppEnv, bearerGroup } from "./groups.ts";

type RouteContext = Context<AppEnv>;
type UserPrincipal = Extract<Principal, { kind: "user" }>;

const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const UNAUTHORIZED = 401;
const UNAVAILABLE = 503;
const MAX_BODY_BYTES = 64 * 1024;
const RETRY_AFTER_SECONDS = "30";

type LogEntry = Record<string, unknown>;

export interface DeskRouteOptions
  extends Pick<BearerAuthOptions, "isOrgMember"> {
  /** Runs work after the response. `executionCtx.waitUntil` by default. */
  defer?: (c: RouteContext, work: Promise<unknown>) => void;
  /** Structured log line. `console.log` of JSON by default (`wrangler tail`). */
  log?: (entry: LogEntry) => void;
}

const defaultLog = (entry: LogEntry) => {
  console.log(JSON.stringify(entry));
};

const defaultDefer = (c: RouteContext, work: Promise<unknown>) => {
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    // No execution context (a test): the work still runs, nobody waits for it.
  }
};

/** A zod issue as "field: message", naming the first bad field. */
const describeIssue = (error: z.ZodError): string => {
  const [issue] = error.issues;
  if (!issue) {
    return "The body is not valid.";
  }
  const path = issue.path.join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
};

const unauthorized = (hadToken: boolean): Response =>
  Response.json(
    { error: hadToken ? "invalid_token" : "unauthorized" },
    {
      headers: {
        "WWW-Authenticate": `Bearer realm="harbourmaster"${
          hadToken ? ', error="invalid_token"' : ""
        }`,
      },
      status: UNAUTHORIZED,
    }
  );

/** What a service refused with, as a response. Anything else is a bug and rethrows. */
const refusal = (c: RouteContext, error: unknown): Response => {
  if (isForbiddenError(error)) {
    return c.json({ error: "Not allowed." }, FORBIDDEN);
  }
  if (isServiceError(error)) {
    return c.json(
      { error: error.message },
      error.status as ContentfulStatusCode
    );
  }
  if (error instanceof z.ZodError) {
    return c.json({ error: describeIssue(error) }, BAD_REQUEST);
  }
  throw error;
};

/** The JSON body, or the response that refuses it. */
const readJson = async (
  c: RouteContext
): Promise<{ json: unknown; ok: true } | { ok: false; response: Response }> => {
  const body = await readCappedBody(c.req.raw, MAX_BODY_BYTES);
  if (!body.ok) {
    return { ok: false, response: c.json({ error: body.error }, body.status) };
  }
  try {
    return {
      json: JSON.parse(new TextDecoder().decode(body.bytes)) as unknown,
      ok: true,
    };
  } catch {
    return {
      ok: false,
      response: c.json({ error: "The body must be JSON." }, BAD_REQUEST),
    };
  }
};

/** Keys only: a token that is not an `hm_` credential verifies to nothing. */
const noOAuth = {
  clientName: () => () => Promise.resolve(null),
  verifyOAuthToken: () => () => Promise.resolve(null),
} satisfies Omit<BearerAuthOptions, "isOrgMember">;

export const deskRoutes = ({
  defer = defaultDefer,
  isOrgMember,
  log = defaultLog,
}: DeskRouteOptions) => {
  const routes = bearerGroup();

  /** The member the request acts for, or the response that refuses it. */
  const memberOrRefusal = async (
    c: RouteContext
  ): Promise<{ credential: Principal; member: UserPrincipal } | Response> => {
    const authorization = c.req.header("Authorization") ?? null;
    let credential: Principal | null;
    try {
      credential = await authenticateBearer(
        { composed: c.get("composed"), env: c.env },
        { ...noOAuth, isOrgMember },
        authorization
      );
    } catch (error: unknown) {
      // D1 or Clerk failed, or a key is not configured: an outage, not a bad token.
      log({
        event: "desk.error",
        message: error instanceof Error ? error.message : String(error),
        phase: "authenticate",
      });
      return c.json({ error: "temporarily_unavailable" }, UNAVAILABLE, {
        "Retry-After": RETRY_AFTER_SECONDS,
      });
    }
    if (!credential) {
      log({ event: "desk.denied", reason: "credential" });
      return unauthorized(authorization !== null);
    }
    try {
      const member = await c
        .get("composed")
        .services.deskApi.actingMember(
          credential,
          c.req.header("X-On-Behalf-Of") ?? null
        );
      return { credential, member };
    } catch (error: unknown) {
      if (isForbiddenError(error)) {
        log({ event: "desk.denied", reason: error.message });
      }
      return refusal(c, error);
    }
  };

  /** After a successful call: stamp the key last used. */
  const recordUse = (c: RouteContext, credential: Principal) => {
    if (credential.kind !== "user" || !credential.apiKey) {
      return;
    }
    const { id } = credential.apiKey;
    defer(
      c,
      c
        .get("composed")
        .services.apiKeys.touch(id, credential.workspaceId)
        .catch((error: unknown) =>
          log({
            event: "desk.touch_failed",
            keyId: id,
            message: error instanceof Error ? error.message : String(error),
          })
        )
    );
  };

  routes.get("/needs-you", async (c) => {
    const acting = await memberOrRefusal(c);
    if (acting instanceof Response) {
      return acting;
    }
    try {
      const items = await c
        .get("composed")
        .services.deskApi.needsYou(acting.member);
      recordUse(c, acting.credential);
      return c.json(items);
    } catch (error) {
      return refusal(c, error);
    }
  });

  routes.post("/requests/:id/decision", async (c) => {
    const acting = await memberOrRefusal(c);
    if (acting instanceof Response) {
      return acting;
    }
    const read = await readJson(c);
    if (!read.ok) {
      return read.response;
    }
    const parsed = deskDecisionInputSchema.safeParse(read.json);
    if (!parsed.success) {
      return c.json({ error: describeIssue(parsed.error) }, BAD_REQUEST);
    }
    try {
      const result = await c
        .get("composed")
        .services.deskApi.decide(acting.member, c.req.param("id"), parsed.data);
      recordUse(c, acting.credential);
      return c.json(result);
    } catch (error) {
      return refusal(c, error);
    }
  });

  routes.post("/controller/messages", async (c) => {
    const acting = await memberOrRefusal(c);
    if (acting instanceof Response) {
      return acting;
    }
    const read = await readJson(c);
    if (!read.ok) {
      return read.response;
    }
    const parsed = deskMessageInputSchema.safeParse(read.json);
    if (!parsed.success) {
      return c.json({ error: describeIssue(parsed.error) }, BAD_REQUEST);
    }
    try {
      const result = await c
        .get("composed")
        .services.deskApi.sendToController(acting.member, parsed.data);
      recordUse(c, acting.credential);
      return c.json(result);
    } catch (error) {
      return refusal(c, error);
    }
  });

  return routes;
};
