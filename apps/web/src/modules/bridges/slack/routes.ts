import { Hono } from "hono";
import { createDb } from "#/db/client";
import { publishMessage } from "#/modules/messaging/publish";
import { claimSlackEvent } from "../events-seen";
import { recordExternalRef } from "../refs";
import { createSlackAdapter } from "./adapter";
import { readSlackConfig, SLACK_CONNECTOR } from "./config";
import { parseSlackEnvelope } from "./events";
import { ingestSlackEvent } from "./ingest";
import { readSignatureHeaders, verifySlackSignature } from "./signature";

/**
 * `POST /api/bridges/slack/events` - deliberately outside `requireAuth`:
 * Slack has no Clerk session, its signature is the credential.
 *
 * Slack gives us three seconds. We verify, claim and ack, then do the real work
 * in `waitUntil`. At this volume that is enough; if inbound ever outgrows one
 * Worker invocation, this is the seam where a Queue goes in - the handler would
 * enqueue instead of calling `ingestSlackEvent` directly.
 */

const UNAUTHORIZED = 401;
const SERVICE_UNAVAILABLE = 503;

export const slackRoutes = new Hono<{ Bindings: Env }>();

slackRoutes.post("/events", async (c) => {
  const config = readSlackConfig(c.env);
  if (!config) {
    return c.json(
      { error: "Slack is not configured on this deployment." },
      SERVICE_UNAVAILABLE
    );
  }

  // Signed over the raw body, and checked before the payload is trusted for
  // anything at all - including the `url_verification` handshake.
  const rawBody = await c.req.text();
  const verification = await verifySlackSignature({
    headers: readSignatureHeaders(c.req.raw.headers),
    rawBody,
    signingSecret: config.signingSecret,
  });
  if (!verification.valid) {
    return c.json(
      { error: `Invalid signature (${verification.reason}).` },
      UNAUTHORIZED
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Expected a JSON body." }, 400);
  }

  const envelope = parseSlackEnvelope(parsed);
  if (!envelope) {
    // An event type we do not handle. Slack must still see a 200, or it retries.
    return c.json({ ok: true });
  }

  if (envelope.type === "url_verification") {
    return c.json({ challenge: envelope.challenge });
  }

  const db = createDb(c.env.DB);
  const adapter = createSlackAdapter(db, c.env);
  c.executionCtx.waitUntil(
    ingestSlackEvent(envelope, adapter, {
      claimEvent: (eventId) => claimSlackEvent(db, eventId),
      publish: (input) => publishMessage(db, c.env, input),
      recordMessageRef: (ref) => recordExternalRef(db, SLACK_CONNECTOR, ref),
    })
  );

  return c.json({ ok: true });
});
