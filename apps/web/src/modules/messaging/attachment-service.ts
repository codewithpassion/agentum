import { and, eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { validateAttachment } from "./attachment-rules";
import { type Attachment, attachments, channels, messages } from "./schema";

export type StoreAttachmentResult =
  | { ok: true; attachment: Attachment }
  | { ok: false; reason: string };

interface AttachmentRow {
  filename: string;
  id: string;
  mime: string;
  r2Key: string;
  size: number;
}

/**
 * The row, written once the bytes are already in R2. Shared by both entry
 * points so they cannot drift on the cleanup: an object with no row pointing at
 * it is an orphan that nothing will ever collect.
 */
const recordAttachment = async (
  db: Db,
  bucket: R2Bucket,
  row: AttachmentRow
): Promise<Attachment> => {
  const [attachment] = await db.insert(attachments).values(row).returning();

  if (!attachment) {
    await bucket.delete(row.r2Key);
    throw new Error("Failed to record the attachment.");
  }
  return attachment;
};

/**
 * Uploads happen before the message exists, so the row starts unlinked and is
 * claimed by `createMessage`.
 *
 * Takes a whole `File`, which means the bytes are already in the isolate's
 * heap: this is the shape the Slack mirror needs, since `downloadFile` hands it
 * one, and it is capped at `MAX_BRIDGE_ATTACHMENT_BYTES` for that reason. The
 * composer uses `storeAttachmentStream` instead.
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

  const attachment = await recordAttachment(db, bucket, {
    filename: validation.filename,
    id,
    mime: validation.mime,
    r2Key,
    size: file.size,
  });
  return { attachment, ok: true };
};

export interface StoreAttachmentStreamInput {
  body: ReadableStream<Uint8Array>;
  bucket: R2Bucket;
  db: Db;
  filename: string;
  mime: string;
  /** The client's `Content-Length`; `FixedLengthStream` holds it to it. */
  size: number;
}

/**
 * The composer's upload path: bytes go from the request body into R2 without
 * ever being gathered up in the isolate, which is the only way a file near the
 * 100MB cap fits in a 128MB isolate that is shared with every other request in
 * flight. Reading the same upload with `formData()` is what used to decide it.
 *
 * `size` is only ever the client's claim, so `FixedLengthStream` is what makes
 * the claim binding rather than decorative: workerd errors the stream if the
 * body turns out shorter or longer than declared, and R2 commits nothing, so a
 * caller that lies gets a failed upload instead of a truncated object stored
 * under an honest-looking size. R2 also needs a stream whose length it knows up
 * front - handed a plain `TransformStream` it does not fail but hangs, until
 * the runtime kills the request as stuck.
 */
export const storeAttachmentStream = async ({
  body,
  bucket,
  db,
  filename,
  mime,
  size,
}: StoreAttachmentStreamInput): Promise<StoreAttachmentResult> => {
  const validation = validateAttachment({ filename, mime, size });
  if (!validation.ok) {
    return validation;
  }

  const id = crypto.randomUUID();
  const r2Key = `attachments/${id}`;
  // biome-ignore lint/correctness/noUndeclaredVariables: FixedLengthStream is a Workers runtime global
  const counted = new FixedLengthStream(size);

  // Started together on purpose: the put drains the readable end while the body
  // fills the writable one, so awaiting either on its own deadlocks. Settled
  // rather than raced because a length mismatch rejects only the put, and
  // leaving the other promise unhandled would surface as a stray rejection.
  const outcomes = await Promise.allSettled([
    body.pipeTo(counted.writable),
    bucket.put(r2Key, counted.readable, {
      httpMetadata: { contentType: validation.mime },
    }),
  ]);

  if (outcomes.some((outcome) => outcome.status === "rejected")) {
    // Nothing is committed when the length is what went wrong, which is the
    // usual cause; the delete is here so that stays true however else the put
    // failed - a dropped connection, or R2 itself.
    await bucket.delete(r2Key);
    return { ok: false, reason: "The upload did not complete." };
  }

  const attachment = await recordAttachment(db, bucket, {
    filename: validation.filename,
    id,
    mime: validation.mime,
    r2Key,
    size,
  });
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
