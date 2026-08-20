import { Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import { badRequest, notFound } from "#/api/validation";
import { createDb } from "#/db/client";
import { isInlineMimeType, MAX_ATTACHMENT_BYTES } from "../attachment-rules";
import {
  getAttachmentInWorkspace,
  storeAttachment,
} from "../attachment-service";
import { attachmentUrl } from "../service";

const PAYLOAD_TOO_LARGE = 413;

export const attachmentsRoutes = new Hono<ApiEnv>();

attachmentsRoutes.use("*", requireAuth);

attachmentsRoutes.post("/", async (c) => {
  // Cheap rejection before buffering the body; `storeAttachment` re-checks the
  // real size, since Content-Length is client-supplied.
  const declaredLength = Number(c.req.header("content-length") ?? 0);
  if (declaredLength > MAX_ATTACHMENT_BYTES) {
    return c.json({ error: "The file is too large." }, PAYLOAD_TOO_LARGE);
  }

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw badRequest('Expected a multipart "file" field.');
  }

  const result = await storeAttachment(
    createDb(c.env.DB),
    c.env.ATTACHMENTS,
    file
  );
  if (!result.ok) {
    return c.json({ error: result.reason }, 400);
  }

  const { attachment } = result;
  return c.json(
    {
      attachment: {
        id: attachment.id,
        filename: attachment.filename,
        mime: attachment.mime,
        size: attachment.size,
        url: attachmentUrl(c.get("workspace").slug, attachment.id),
      },
    },
    201
  );
});

attachmentsRoutes.get("/:id", async (c) => {
  const attachment = await getAttachmentInWorkspace(
    createDb(c.env.DB),
    c.get("workspace").id,
    c.req.param("id")
  );
  if (!attachment) {
    throw notFound("Attachment not found.");
  }

  const object = await c.env.ATTACHMENTS.get(attachment.r2Key);
  if (!object) {
    throw notFound("Attachment content is missing.");
  }

  const disposition = isInlineMimeType(attachment.mime)
    ? "inline"
    : "attachment";

  return new Response(object.body, {
    headers: {
      "Content-Type": attachment.mime,
      "Content-Length": String(attachment.size),
      "Content-Disposition": `${disposition}; filename="${attachment.filename}"`,
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
});
