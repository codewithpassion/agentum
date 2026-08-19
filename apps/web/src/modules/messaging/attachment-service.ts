import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { validateAttachment } from "./attachment-rules";
import { type Attachment, attachments } from "./schema";

export type StoreAttachmentResult =
  | { ok: true; attachment: Attachment }
  | { ok: false; reason: string };

/**
 * Uploads happen before the message exists, so the row starts unlinked and is
 * claimed by `createMessage`.
 */
export const storeAttachment = async (
  db: Db,
  bucket: R2Bucket,
  file: File
): Promise<StoreAttachmentResult> => {
  const validation = validateAttachment({
    filename: file.name,
    mime: file.type,
    size: file.size,
  });
  if (!validation.ok) {
    return validation;
  }

  const id = crypto.randomUUID();
  const r2Key = `attachments/${id}`;
  await bucket.put(r2Key, file.stream(), {
    httpMetadata: { contentType: validation.mime },
  });

  const [attachment] = await db
    .insert(attachments)
    .values({
      filename: validation.filename,
      id,
      mime: validation.mime,
      r2Key,
      size: file.size,
    })
    .returning();

  if (!attachment) {
    await bucket.delete(r2Key);
    throw new Error("Failed to record the attachment.");
  }
  return { attachment, ok: true };
};

export const getAttachment = async (
  db: Db,
  id: string
): Promise<Attachment | undefined> => {
  const [attachment] = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, id));
  return attachment;
};
