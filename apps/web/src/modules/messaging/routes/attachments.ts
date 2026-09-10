import { Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import { badRequest, notFound } from "#/api/validation";
import { createDb } from "#/db/client";
import { isInlineMimeType, MAX_ATTACHMENT_BYTES } from "../attachment-rules";
import {
  getAttachmentInWorkspace,
  storeAttachmentStream,
} from "../attachment-service";
import { attachmentUrl } from "../service";

const PAYLOAD_TOO_LARGE = 413;

/**
 * The filename travels in a header rather than the body, so it is
 * percent-encoded: header values are Latin-1, and plenty of real filenames are
 * not.
 */
const FILENAME_HEADER = "x-attachment-filename";

/** Refuses a header that is missing, or not a percent-encoding at all. */
const decodeFilename = (raw: string | undefined): string => {
  if (raw === undefined) {
    throw badRequest(`Expected an ${FILENAME_HEADER} header.`);
  }
  try {
    return decodeURIComponent(raw);
  } catch (error) {
    throw badRequest(
      `Expected ${FILENAME_HEADER} to be percent-encoded.`,
      error
    );
  }
};

export const attachmentsRoutes = new Hono<ApiEnv>();

attachmentsRoutes.use("*", requireAuth);

/**
 * The file is the raw request body: `Content-Type` carries its mime,
 * `Content-Length` its size, and `X-Attachment-Filename` its name. A multipart
 * form would mean `formData()`, which gathers the whole upload into the
 * isolate's heap - fatal at this cap, and pure overhead even below it.
 *
 * Content-Length is the client's word, so it decides only whether to accept the
 * upload at all; `storeAttachmentStream` is what holds the body to it.
 */
attachmentsRoutes.post("/", async (c) => {
  const declaredLength = Number(c.req.header("content-length"));
  // Both answer 413, but not with the same sentence: a body of unknown length
  // is refused for being unmeasurable, not for being big, and the composer
  // shows the caller whichever of these it gets.
  if (!(Number.isSafeInteger(declaredLength) && declaredLength > 0)) {
    return c.json(
      { error: "A Content-Length is required." },
      PAYLOAD_TOO_LARGE
    );
  }
  if (declaredLength > MAX_ATTACHMENT_BYTES) {
    return c.json({ error: "The file is too large." }, PAYLOAD_TOO_LARGE);
  }

  const filename = decodeFilename(c.req.header(FILENAME_HEADER));

  const { body } = c.req.raw;
  if (!body) {
    throw badRequest("Expected the file as the request body.");
  }

  const result = await storeAttachmentStream({
    body,
    bucket: c.env.ATTACHMENTS,
    db: createDb(c.env.DB),
    filename,
    mime: c.req.header("content-type") ?? "",
    size: declaredLength,
  });
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
