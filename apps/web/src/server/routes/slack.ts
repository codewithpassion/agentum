// The Slack receivers. `POST /api/slack/events` is the Events API one, and
// `POST /api/slack/interactions` takes button clicks and modal submissions.
// Slack calls them with a signature, not a bearer token, so the service checks
// who is calling and this file only reads the body and maps the outcome to a
// status. The answer goes out as soon as the service has written the run (or
// read the click): file downloads, replies and Slack calls run afterwards in
// `waitUntil`.

import { readCappedBody } from "@repo/app-gateway/body";
import type { Context } from "hono";
import { type AppEnv, bearerGroup } from "./groups.ts";

/** Slack events are small; the largest are a few KB of text and file metadata. */
const MAX_BODY_BYTES = 256 * 1024;
const OK = 200;
const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;

export interface SlackRoutesDeps {
  /**
   * Starts work after the answer has gone out. The default hands it to the
   * request's `waitUntil`, which keeps the Worker alive until it finishes.
   */
  defer?: (c: Context<AppEnv>, job: () => Promise<void>) => void;
}

const requestDefer = (c: Context<AppEnv>, job: () => Promise<void>) => {
  c.executionCtx.waitUntil(job());
};

export const slackRoutes = ({ defer = requestDefer }: SlackRoutesDeps = {}) => {
  const routes = bearerGroup();

  routes.post("/events", async (c) => {
    const body = await readCappedBody(c.req.raw, MAX_BODY_BYTES);
    if (!body.ok) {
      return c.json({ error: body.error }, body.status);
    }
    const result = await c.get("composed").services.slack.receive({
      rawBody: new TextDecoder().decode(body.bytes),
      signature: c.req.header("X-Slack-Signature") ?? "",
      timestamp: c.req.header("X-Slack-Request-Timestamp") ?? "",
    });
    switch (result.kind) {
      case "challenge":
        return c.text(result.challenge);
      case "malformed":
        return c.json({ error: "Not a Slack event." }, BAD_REQUEST);
      case "unauthorized":
        return c.json({ error: "Not signed by Slack." }, UNAUTHORIZED);
      default:
        if (result.after) {
          defer(c, result.after);
        }
        return c.json({ ok: true, runId: result.runId });
    }
  });

  routes.post("/interactions", async (c) => {
    const body = await readCappedBody(c.req.raw, MAX_BODY_BYTES);
    if (!body.ok) {
      return c.json({ error: body.error }, body.status);
    }
    const result = await c.get("composed").services.slackRequests.interact({
      rawBody: new TextDecoder().decode(body.bytes),
      signature: c.req.header("X-Slack-Signature") ?? "",
      timestamp: c.req.header("X-Slack-Request-Timestamp") ?? "",
    });
    switch (result.kind) {
      case "malformed":
        return c.json({ error: "Not a Slack interaction." }, BAD_REQUEST);
      case "unauthorized":
        return c.json({ error: "Not signed by Slack." }, UNAUTHORIZED);
      default:
        if (result.after) {
          defer(c, result.after);
        }
        return result.response ? c.json(result.response) : c.body(null, OK);
    }
  });

  return routes;
};
