// The ingest route for HTTP triggers, `POST /api/triggers/:id`. The caller
// presents the trigger's own bearer token (`ag_trg_`). The service decides
// what the token may do, so this file checks the header and the id, parses
// the body, and maps what the services refuse to a status. Mount with
// `automationRoutes.route("/api/triggers", triggerRoutes())`.
import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import {
  type FireResult,
  type TriggerPrincipal,
  triggerFireInputSchema,
} from "@repo/services/triggers";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { readCappedBody } from "../mcp/body.ts";
import { type AppEnv, bearerGroup } from "./groups.ts";

type RouteContext = Context<AppEnv>;

const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const MAX_BODY_BYTES = 512 * 1024;

/** A zod issue as "field: message", naming the first bad field. */
const describeIssue = (error: z.ZodError): string => {
  const [issue] = error.issues;
  if (!issue) {
    return "The body is not valid.";
  }
  const path = issue.path.join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
};

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

const readInput = async (
  c: RouteContext
): Promise<
  | { ok: true; input: z.output<typeof triggerFireInputSchema> }
  | { ok: false; response: Response }
> => {
  const body = await readCappedBody(c.req.raw, MAX_BODY_BYTES);
  if (!body.ok) {
    return {
      ok: false,
      response: c.json({ error: body.error }, body.status),
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(body.bytes));
  } catch {
    return {
      ok: false,
      response: c.json({ error: "The body must be JSON." }, BAD_REQUEST),
    };
  }
  const parsed = triggerFireInputSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      response: c.json({ error: describeIssue(parsed.error) }, BAD_REQUEST),
    };
  }
  return { ok: true, input: parsed.data };
};

const fireResponse = (c: RouteContext, result: FireResult): Response => {
  const { run } = result;
  if (result.finished) {
    return c.json({
      error: run.error,
      result: run.resultText,
      runId: run.id,
      sessionId: run.sessionId,
      status: run.status,
    });
  }
  return c.json(
    {
      runId: run.id,
      sessionId: run.sessionId,
      status: run.status,
    },
    202
  );
};

export const triggerRoutes = () => {
  const routes = bearerGroup();

  routes.post("/:id", async (c) => {
    const principal: TriggerPrincipal | null = await c
      .get("composed")
      .services.triggers.authenticate(c.req.header("Authorization") ?? null);
    if (!principal) {
      return c.json({ error: "Invalid trigger token." }, UNAUTHORIZED, {
        "WWW-Authenticate": 'Bearer realm="agentum"',
      });
    }
    const triggerId = c.req.param("id");
    if (principal.triggerId !== triggerId) {
      return c.json({ error: "Not allowed." }, FORBIDDEN);
    }
    const read = await readInput(c);
    if (!read.ok) {
      return read.response;
    }
    try {
      const result = await c
        .get("composed")
        .services.triggers.fire(principal, triggerId, read.input);
      return fireResponse(c, result);
    } catch (error) {
      return refusal(c, error);
    }
  });

  return routes;
};
