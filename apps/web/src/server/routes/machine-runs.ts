// The routes a machine's daemon calls for one run, under `/api/machines/runs`.
// Every call carries the machine credential (`hm_mach_`). The services decide
// who may act on the run, so this file maps what they refuse to a status.
// Mount with `machines.route("/runs", machineRunRoutes())`.
import {
  claimResponseSchema,
  completeRequestSchema,
  DAEMON_FEATURES_HEADER,
  eventsRequestSchema,
  eventsResponseSchema,
  FEATURE_LIBRARY_SYNC,
  hasDaemonFeature,
} from "@repo/protocol/machine";
import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import type { MachinePrincipal } from "@repo/services/machines";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { type AppEnv, bearerGroup } from "./groups.ts";

type RouteContext = Context<AppEnv>;
type RunHandler = (call: {
  c: RouteContext;
  principal: MachinePrincipal;
  runId: string;
}) => Promise<Response>;

const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;

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
    return c.json({ error: "The request body is not valid." }, BAD_REQUEST);
  }
  throw error;
};

const withMachine =
  (handler: RunHandler) =>
  async (c: RouteContext): Promise<Response> => {
    const principal = await c
      .get("composed")
      .services.machines.authenticate(c.req.header("Authorization") ?? null);
    if (!principal) {
      return c.json({ error: "Invalid machine credential." }, UNAUTHORIZED);
    }
    try {
      return await handler({ c, principal, runId: c.req.param("runId") ?? "" });
    } catch (error) {
      return refusal(c, error);
    }
  };

const readJson = (c: RouteContext): Promise<unknown> =>
  c.req.json().catch(() => undefined);

export const machineRunRoutes = () => {
  const routes = bearerGroup();

  routes.post(
    "/:runId/claim",
    withMachine(async ({ c, principal, runId }) => {
      const claim = await c
        .get("composed")
        .services.runs.claimRunForMachine(principal, runId, {
          // Only a daemon that says so gets the library part of the claim; an
          // older one rejects a key it does not know.
          libraryForDaemon: hasDaemonFeature(
            c.req.header(DAEMON_FEATURES_HEADER),
            FEATURE_LIBRARY_SYNC
          ),
          // The address the daemon reached us at is one it can use for /mcp.
          platformUrl: new URL(c.req.url).origin,
        });
      return c.json(claimResponseSchema.parse(claim));
    })
  );

  routes.post(
    "/:runId/events",
    withMachine(async ({ c, principal, runId }) => {
      const body = eventsRequestSchema.safeParse(await readJson(c));
      if (!body.success) {
        return c.json(
          { error: "Expected JSON with an events array." },
          BAD_REQUEST
        );
      }
      const stored = await c
        .get("composed")
        .services.runs.ingestRunEvents(principal, runId, body.data.events);
      return c.json(eventsResponseSchema.parse(stored));
    })
  );

  routes.post(
    "/:runId/heartbeat",
    withMachine(async ({ c, principal, runId }) => {
      await c.get("composed").services.runs.heartbeatRun(principal, runId);
      return c.json({});
    })
  );

  routes.post(
    "/:runId/complete",
    withMachine(async ({ c, principal, runId }) => {
      const body = completeRequestSchema.safeParse(await readJson(c));
      if (!body.success) {
        return c.json(
          { error: "Expected a done, failed or aborted result." },
          BAD_REQUEST
        );
      }
      await c
        .get("composed")
        .services.runs.completeRun(principal, runId, body.data);
      return c.json({});
    })
  );

  return routes;
};
