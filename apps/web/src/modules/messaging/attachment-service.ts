import { and, eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { validateAttachment } from "./attachment-rules";
import { type Attachment, attachments, channels, messages } from "./schema";

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

/**
 * By bare id, for the outbound bridge mirror, which resolves its tenancy
 * through the bridge row instead.
 */
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

/**
 * An attachment reached by bare id, scoped through its parent chain -
 * attachment → message → channel → workspace, since `attachments` carries no
 * workspace column of its own.
 *
 * An attachment with no message yet is a just-uploaded file that no message has
 * claimed: there is no parent to scope it through, its id is an unguessable
 * UUID, and refusing it would break the composer's own preview of what it just
 * uploaded. `createMessage` is what decides who may claim one.
 */
export const getAttachmentInWorkspace = async (
  db: Db,
  workspaceId: string,
  id: string
): Promise<Attachment | undefined> => {
  const attachment = await getAttachment(db, id);
  if (!attachment) {
    return;
  }
  if (!attachment.messageId) {
    return attachment;
  }

  const [parent] = await db
    .select({ id: channels.id })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(
      and(
        eq(messages.id, attachment.messageId),
        eq(channels.workspaceId, workspaceId)
      )
    );
  return parent ? attachment : undefined;
};
