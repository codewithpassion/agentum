// The external desk API (contract C4), `/api/desk/*`. An outside app (flightdex)
// calls it from its own server with an `ag_key_` key that has the `desk` scope
// and an `X-On-Behalf-Of: <email>` header naming the member it acts for. A
// connected app's OAuth token is not a credential here: it is never sent to
// Clerk, so it cannot register a client either. The service decides who may
// do what, so this file authenticates, parses the body and maps what the
// services refuse to a status. `GET /api/desk/stream` is the live side: the
// request.* and run.* frames of the workspace, from the `desk:<workspaceId>`
// SessionStream instance, kept to the runs the member may see. Mount with
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
import { DESK_EVENT_TYPES, deskStreamName } from "../session-stream-frames.ts";
import { type AppEnv, bearerGroup } from "./groups.ts";
import {
  NO_REPLAY,
  RESUME_ID_MAX,
  relay,
  replay,
  STREAM_HEADERS,
} from "./session-stream.ts";

type RouteContext = Context<AppEnv>;
type UserPrincipal = Extract<Principal, { kind: "user" }>;

const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const UNAUTHORIZED = 401;
const UNAVAILABLE = 503;
const MAX_BODY_BYTES = 64 * 1024;
const RETRY_AFTER_SECONDS = "30";
const DATA_LINE = /^data: (.+)$/m;

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

/**
 * The run a live SSE block belongs to: its `runId` when it names one, true
 * for a ping, which belongs to nobody. Null for any other block.
 */
const runOfBlock = (block: string): string | true | null => {
  const data = DATA_LINE.exec(block)?.[1];
  if (data === undefined) {
    return null;
  }
  try {
    const frame = JSON.parse(data) as { frame?: unknown; runId?: unknown };
    if (frame.frame === "ping") {
      return true;
    }
    return typeof frame.runId === "string" ? frame.runId : null;
  } catch {
    return null;
  }
};

/** Keys only: a token that is not an `ag_` or `hm_` credential verifies to nothing. */
const noOAuth = {
  clientName: () => () => Promise.resolve(null),
  userOrgIds: () => () => Promise.resolve([]),
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
      // The audit trail: who held the key, and who it acted for.
      log({
        actingUserId: member.userId,
        event: "desk.request",
        keyId: credential.kind === "user" ? credential.apiKey?.id : null,
        keyOwnerId: credential.kind === "user" ? credential.userId : null,
        method: c.req.method,
        path: c.req.path,
      });
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

  routes.get("/runs/:runId", async (c) => {
    const acting = await memberOrRefusal(c);
    if (acting instanceof Response) {
      return acting;
    }
    try {
      const run = await c
        .get("composed")
        .services.deskApi.readRun(acting.member, c.req.param("runId"));
      recordUse(c, acting.credential);
      return c.json(run);
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

  routes.get("/stream", async (c) => {
    const acting = await memberOrRefusal(c);
    if (acting instanceof Response) {
      return acting;
    }
    const { member } = acting;
    const resume = c.req.header("Last-Event-ID") || c.req.query("after");
    if (resume && resume.length > RESUME_ID_MAX) {
      return c.json({ error: "Invalid resume point." }, BAD_REQUEST);
    }
    const composed = c.get("composed");
    // What the member may see is asked once per run for this connection.
    const seen = new Map<string, Promise<boolean>>();
    const canSee = (runId: string): Promise<boolean> => {
      const known = seen.get(runId);
      if (known) {
        return known;
      }
      const answer = composed.services.deskApi.canSeeRun(member, runId);
      seen.set(runId, answer);
      return answer;
    };

    const namespace = c.env.SESSION_STREAM;
    // Subscribe before the D1 read, so no event falls between the two.
    const live = await namespace
      .get(namespace.idFromName(deskStreamName(member.workspaceId)))
      .fetch(
        new Request("https://session-stream/stream", {
          signal: c.req.raw.signal,
        })
      );
    if (!live.body) {
      throw new Error("The desk stream sent no body");
    }
    const liveBody = live.body;

    let replayed = NO_REPLAY;
    if (resume) {
      try {
        replayed = await replay(
          composed.services.events,
          member,
          {
            keep: ({ runId }) =>
              runId === null ? Promise.resolve(false) : canSee(runId),
            types: DESK_EVENT_TYPES,
          },
          resume
        );
      } catch (error: unknown) {
        await liveBody.cancel();
        return refusal(c, error);
      }
    }
    recordUse(c, acting.credential);

    return new Response(
      relay(replayed, liveBody, (block) => {
        const run = runOfBlock(block);
        return run === null || run === true
          ? Promise.resolve(run === true)
          : canSee(run);
      }),
      { headers: STREAM_HEADERS }
    );
  });

  return routes;
};
