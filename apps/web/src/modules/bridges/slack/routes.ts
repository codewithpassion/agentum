import { Hono } from "hono";
import { createDb } from "#/db/client";
import { publishMessage } from "#/modules/messaging/publish";
import { addChannelMember, createChannel } from "#/modules/messaging/service";
import { findBridgeByExternalChannel, upsertBridge } from "../bridges";
import { claimSlackKey } from "../events-seen";
import { recordExternalRef } from "../refs";
import { createSlackAdapter, slackClientForApp } from "./adapter";
import { findSlackAppById, slackAppSigningSecret } from "./apps";
import { SLACK_CONNECTOR } from "./config";
import { parseSlackEnvelope } from "./events";
import { ingestSlackEvent } from "./ingest";
import {
  handleQuestionInteraction,
  parseSlackInteraction,
} from "./interactive";
import { botUserIdOf } from "./normalize";
import { provisionSlackChannel, SLACK_JOINED_EVENT } from "./provision";
import { readSignatureHeaders, verifySlackSignature } from "./signature";

/**
 * `POST /api/bridges/slack/:slackAppId` - one events URL per connected agent,
 * deliberately outside `requireAuth`: Slack has no Clerk session, and the
 * signature made with *that app's* signing secret is the credential.
 *
 * The id in the path is not a credential either - it is a random row id, and
 * the only thing an unknown one reveals is that no app has it. It is answered
 * with 404 rather than a silent 200 so a mistyped or stale events URL fails
 * loudly in Slack's own UI instead of looking like it works.
 *
 * Slack gives us three seconds. We verify, claim and ack, then do the real work
 * in `waitUntil`. At this volume that is enough; if inbound ever outgrows one
 * Worker invocation, this is the seam where a Queue goes in - the handler would
 * enqueue instead of calling `ingestSlackEvent` directly.
 */

const UNAUTHORIZED = 401;
const NOT_FOUND = 404;

/** `undefined` for a body that is not JSON at all. */
const safeJson = (rawBody: string): unknown => {
  try {
    return JSON.parse(rawBody);
  } catch {
    // Not JSON at all, which every caller reads as "nothing to act on".
  }
};

export const slackRoutes = new Hono<{ Bindings: Env }>();

/**
 * `POST /api/bridges/slack/:slackAppId/interactive` - the button clicks on this
 * app's question cards, named by `settings.interactivity.request_url` in the
 * manifest.
 *
 * Signed exactly like an event (v0 HMAC over the raw body), so the same secret
 * verifies both. What differs: there is no `url_verification` handshake for
 * interactivity, so a draft row - which holds no secret - is refused outright
 * rather than answered.
 *
 * Answering wakes an agent and mirrors a reply, which is more work than Slack's
 * three seconds are meant for; verification and parsing are synchronous, the
 * answer itself rides `waitUntil` and reports back through `response_url`, which
 * stays valid for half an hour.
 */
slackRoutes.post("/:slackAppId/interactive", async (c) => {
  const db = createDb(c.env.DB);
  const app = await findSlackAppById(db, c.req.param("slackAppId"));
  if (!app) {
    return c.json({ error: "Unknown Slack app." }, NOT_FOUND);
  }

  const rawBody = await c.req.text();
  const signingSecret = await slackAppSigningSecret(
    c.env.CONNECTOR_KEY || null,
    app
  );
  if (!signingSecret) {
    return c.json(
      { error: "This Slack app has no credentials yet." },
      UNAUTHORIZED
    );
  }

  const verification = await verifySlackSignature({
    headers: readSignatureHeaders(c.req.raw.headers),
    rawBody,
    signingSecret,
  });
  if (!verification.valid) {
    return c.json(
      { error: `Invalid signature (${verification.reason}).` },
      UNAUTHORIZED
    );
  }

  const interaction = parseSlackInteraction(rawBody);
  // Slack sends shortcuts, view submissions and menu selections down this same
  // URL; anything that is not a button press on a card is acked and ignored.
  if (interaction?.type === "block_actions") {
    c.executionCtx.waitUntil(
      handleQuestionInteraction(db, c.env, app, interaction)
    );
  }

  return c.json({ ok: true });
});

slackRoutes.post("/:slackAppId", async (c) => {
  const db = createDb(c.env.DB);
  const app = await findSlackAppById(db, c.req.param("slackAppId"));
  if (!app) {
    return c.json({ error: "Unknown Slack app." }, NOT_FOUND);
  }

  const rawBody = await c.req.text();
  const signingSecret = await slackAppSigningSecret(
    c.env.CONNECTOR_KEY || null,
    app
  );

  // A row that holds no signing secret is one the wizard has not finished:
  // the manifest names this URL, and Slack verifies it the moment the app is
  // created - before anyone could have pasted us a secret. So an unsigned
  // `url_verification` is answered here, and nothing else is. Echoing Slack's
  // own challenge back to Slack leaks nothing: it says only that this URL
  // exists, which the 404 above already says.
  if (!signingSecret) {
    const unverified = parseSlackEnvelope(safeJson(rawBody));
    if (unverified?.type === "url_verification") {
      return c.json({ challenge: unverified.challenge });
    }
    return c.json(
      { error: "This Slack app has no credentials yet." },
      UNAUTHORIZED
    );
  }

  // Signed over the raw body, and checked before the payload is trusted for
  // anything at all - including a re-run of the handshake.
  const verification = await verifySlackSignature({
    headers: readSignatureHeaders(c.req.raw.headers),
    rawBody,
    signingSecret,
  });
  if (!verification.valid) {
    return c.json(
      { error: `Invalid signature (${verification.reason}).` },
      UNAUTHORIZED
    );
  }

  const parsed = safeJson(rawBody);
  if (parsed === undefined) {
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

  const client = await slackClientForApp(c.env, app);
  if (!client) {
    // Only reachable if the bot token is gone while the signing secret is not.
    return c.json({ ok: true });
  }

  // Being invited to a channel is a setup event, not a message: it makes the
  // channel this app will deliver into, where every other event needs one to
  // already exist.
  if (envelope.event.type === SLACK_JOINED_EVENT) {
    c.executionCtx.waitUntil(
      provisionSlackChannel(envelope, app.botUserId ?? botUserIdOf(envelope), {
        addAgentMember: (channelId) =>
          addChannelMember(db, channelId, {
            memberId: app.agentId,
            memberType: "agent",
          }),
        claim: (key) => claimSlackKey(db, key),
        createBridge: async (input) => {
          await upsertBridge(db, app.workspaceId, {
            agentId: app.agentId,
            channelId: input.channelId,
            connector: SLACK_CONNECTOR,
            externalChannelId: input.externalChannelId,
            slackAppId: app.id,
          });
        },
        createChannel: (name) =>
          createChannel(db, app.workspaceId, {
            name,
            origin: SLACK_CONNECTOR,
          }),
        isBridged: async (externalChannelId) =>
          (await findBridgeByExternalChannel(
            db,
            SLACK_CONNECTOR,
            externalChannelId
          )) !== undefined,
        readChannel: (externalChannelId) =>
          client.conversationsInfo(externalChannelId),
      })
    );
    return c.json({ ok: true });
  }

  // The adapter carries the app: it drops any event whose channel is bridged to
  // a *different* app (two bots in one channel both hear it), and posts as this
  // app's bot.
  const adapter = createSlackAdapter(db, c.env, app, client);
  c.executionCtx.waitUntil(
    ingestSlackEvent(envelope, adapter, {
      claim: (key) => claimSlackKey(db, key),
      publish: (input) => publishMessage(db, c.env, input),
      recordMessageRef: (ref) => recordExternalRef(db, SLACK_CONNECTOR, ref),
    })
  );

  return c.json({ ok: true });
});
