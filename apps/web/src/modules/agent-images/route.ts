import { Hono } from "hono";
import { verifyAttachmentLink } from "#/modules/messaging/attachment-links";

/**
 * `GET /api/agent-images?key=…&exp=…&sig=…` - an image in `ATTACHMENTS` by its
 * R2 key, for the Anthropic API to fetch when an agent is sent a screenshot as
 * a `url` image block. The signature is the whole credential, minted by
 * `sendImageToAgentSession`, and it reuses the attachment-link HMAC with the
 * key as the signed id.
 *
 * Browser screenshots are not rows in `attachments`, so the attachment-link
 * route cannot serve them. Every refusal is the same 404, for the reason given
 * there: no oracle for which keys exist.
 */

export const AGENT_IMAGE_BASE_PATH = "/api/agent-images";

const NOT_FOUND = 404;
/** Signature domain, so an attachment-link signature never opens an image. */
export const AGENT_IMAGE_DOMAIN = "agent-image.v1";
/** Raster formats only: SVG and friends can carry script. */
const SERVED_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const reject = (): Response =>
  Response.json(
    { error: "That link is not valid or has expired." },
    { status: NOT_FOUND }
  );

export const agentImageRoutes = new Hono<{ Bindings: Env }>();

agentImageRoutes.get("/", async (c) => {
  const key = c.req.query("key");
  const signing = c.env.ATTACHMENT_LINK_KEY;
  if (!(key && signing)) {
    return reject();
  }
  const signed = await verifyAttachmentLink(signing, {
    domain: AGENT_IMAGE_DOMAIN,
    exp: c.req.query("exp"),
    id: key,
    sig: c.req.query("sig"),
  });
  if (!signed) {
    return reject();
  }

  const object = await c.env.ATTACHMENTS.get(key);
  const contentType = object?.httpMetadata?.contentType;
  // Only raster images: a signature over some other kind of object must not serve it.
  if (!(object?.body && contentType && SERVED_TYPES.has(contentType))) {
    return reject();
  }

  return new Response(object.body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Length": String(object.size),
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    },
  });
});
