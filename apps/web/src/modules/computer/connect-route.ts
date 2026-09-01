import { Hono } from "hono";
import { createDb } from "#/db/client";
import { findHostByToken } from "./hosts";

/**
 * `GET /api/computer-hosts/connect` - where a self-hosted `computerd`
 * container dials in (docs/plan-computer-backends.md §6). Deliberately outside
 * `requireAuth`, exactly like `/mcp/:token`: the host token in the
 * `Authorization` header is the credential, and it is what names the host.
 *
 * The token is a header and never a query parameter. A browser cannot set
 * headers on a WebSocket upgrade, but the daemon can - and it is the only
 * client this route has, so the weaker variant would only widen where the
 * token can be logged, cached or shoulder-read.
 *
 * Every rejection is a bare 401. Which of "no header", "unknown token" or
 * "that is a Fly host" it was is not something an unauthenticated caller gets
 * to learn.
 */

const UNAUTHORIZED = 401;
const BEARER = /^Bearer (.+)$/;

export const computerConnectRoutes = new Hono<{ Bindings: Env }>();

computerConnectRoutes.get("/connect", async (c) => {
  const presented = BEARER.exec(c.req.header("Authorization") ?? "")?.[1];
  if (!presented) {
    return c.json({ error: "Unauthorized." }, UNAUTHORIZED);
  }

  const host = await findHostByToken(createDb(c.env.DB), presented.trim());
  // A Fly host's token never travels this way - Agentum presents it to the
  // machine, not the other way round - so one arriving here is a wrong token.
  if (host?.kind !== "self_hosted") {
    return c.json({ error: "Unauthorized." }, UNAUTHORIZED);
  }

  // The relay is addressed by host id, and told its host id: a Durable Object
  // cannot be relied on to read back the name it was reached by.
  const stub = c.env.COMPUTER_RELAY.get(
    c.env.COMPUTER_RELAY.idFromName(host.id)
  );
  const relayUrl = new URL(c.req.url);
  relayUrl.pathname = `/hosts/${encodeURIComponent(host.id)}`;
  return await stub.fetch(new Request(relayUrl, c.req.raw));
});
