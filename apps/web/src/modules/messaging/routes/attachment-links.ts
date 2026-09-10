import { Hono } from "hono";
import { createDb } from "#/db/client";
import { verifyAttachmentLink } from "../attachment-links";
import { isInlineMimeType } from "../attachment-rules";
import { getAttachment } from "../attachment-service";

/**
 * `GET /api/attachment-links/:id?exp=…&sig=…` - the one unauthenticated read
 * path to a private file, so that an external service can fetch an attachment
 * itself (a transcription API handed an mp3 is the case it exists for).
 *
 * Deliberately outside `requireAuth` *and* outside the workspace prefix: there
 * is no session here and no `:workspaceSlug` to scope through. The signature is
 * the whole credential, and `attachment_link` (modules/mcp/attachment-tools)
 * already proved the minting agent's workspace could see the file. So the lookup
 * is `getAttachment` by bare id rather than the workspace-scoped one: a
 * workspace read from the URL would be an unauthenticated caller's own claim.
 *
 * The signature is checked before the database is touched, and every refusal is
 * the same response - see `reject`.
 */

const NOT_FOUND = 404;

/**
 * One response for every failure: no signature, an expired or edited one, a
 * signature over another id, an id that does not exist, an id whose R2 object is
 * gone, and a deployment with no `ATTACHMENT_LINK_KEY` at all.
 *
 * They have to be indistinguishable. Anything that told "no such attachment"
 * apart from "wrong signature" would turn this route into an oracle for which
 * attachment ids exist in the deployment, which is most of what an id is worth.
 */
const reject = (): Response =>
  Response.json(
    { error: "That link is not valid or has expired." },
    { status: NOT_FOUND }
  );

export const attachmentLinkRoutes = new Hono<{ Bindings: Env }>();

attachmentLinkRoutes.get("/:id", async (c) => {
  // A deployment that never had a key cannot have minted a link, so there is
  // nothing here that could legitimately verify. Refusing everything up front is
  // the fail-closed half of "a missing key disables minting".
  const key = c.env.ATTACHMENT_LINK_KEY;
  if (!key) {
    return reject();
  }

  const id = c.req.param("id");
  const signed = await verifyAttachmentLink(key, {
    exp: c.req.query("exp"),
    id,
    sig: c.req.query("sig"),
  });
  if (!signed) {
    return reject();
  }

  const attachment = await getAttachment(createDb(c.env.DB), id);
  if (!attachment) {
    return reject();
  }

  const object = await c.env.ATTACHMENTS.get(attachment.r2Key);
  if (!object) {
    return reject();
  }

  const disposition = isInlineMimeType(attachment.mime)
    ? "inline"
    : "attachment";

  return new Response(object.body, {
    headers: {
      // Content-Type, Content-Length and Content-Disposition as the
      // authenticated route serves them, so a client cannot tell the two apart.
      "Content-Type": attachment.mime,
      "Content-Length": String(attachment.size),
      "Content-Disposition": `${disposition}; filename="${attachment.filename}"`,
      // Not the year-long immutable cache the authenticated route sets: a URL
      // whose point is that it stops working must not be held by a proxy past
      // its expiry.
      "Cache-Control": "no-store",
    },
  });
});
