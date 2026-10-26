// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Modified by Harbourmaster: the queries of the inbox's MailboxDO as plain
// functions over a drizzle instance, so bun can test them. Rate-limit and
// thread-window cutoffs are computed here as ISO strings (the inbox compared
// them with SQLite's space-separated datetime(), which let a whole UTC day
// through). New: listThreads, findByDedupeKey, insertInbound and findThreadByIds.

import type { ThreadSummary } from "@repo/services/mail/types";
import { asc, desc, eq, getTableColumns, inArray, or, sql } from "drizzle-orm";
import { attachments, emails, type MailboxDb } from "./schema.ts";
import {
  normalizeSubject,
  resolveThreadId,
  type ThreadReader,
} from "./threading.ts";

export const FOLDERS = {
  archive: "archive",
  draft: "draft",
  inbox: "inbox",
  sent: "sent",
  spam: "spam",
  trash: "trash",
} as const;

export type FolderId = (typeof FOLDERS)[keyof typeof FOLDERS];

export const SEND_LIMIT_PER_HOUR = 20;
export const SEND_LIMIT_PER_DAY = 100;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SUBJECT_WINDOW_MS = 7 * DAY_MS;
const MAX_PAGE_SIZE = 100;
const THREAD_CANDIDATES = 50;

/** A Durable Object's SQLite refuses a statement that binds more than this many parameters. */
export const DO_MAX_BOUND_PARAMS = 100;
const ATTACHMENT_COLUMNS = Object.keys(getTableColumns(attachments)).length;

export type EmailRow = typeof emails.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;

export interface StoredEmail extends EmailRow {
  attachments: AttachmentRow[];
}

/** One message to store. Addresses are lowercase, `recipient` and `cc` are ", " joined lists. */
export interface EmailInput {
  bcc: string | null;
  body: string;
  bodyIsHtml: boolean;
  cc: string | null;
  date: string;
  dedupeKey: string | null;
  /** A JSON array of RFC message ids, or null. */
  emailReferences: string | null;
  id: string;
  inReplyTo: string | null;
  messageId: string | null;
  rawHeaders: string | null;
  recipient: string;
  sender: string;
  subject: string;
  threadId: string | null;
}

export type AttachmentInput = Omit<AttachmentRow, "emailId">;

/** An inbound mail before its thread is known. The store resolves the thread. */
export type InboundInsert = Omit<
  EmailInput,
  "bcc" | "dedupeKey" | "emailReferences" | "threadId"
> & {
  attachments: AttachmentInput[];
  dedupeKey: string;
  references: string[];
};

export interface InboundResult {
  attachments: AttachmentRow[];
  duplicate: boolean;
  id: string;
  threadId: string;
}

/** The fields of a sent or drafted mail that move with its delivery. */
export type EmailChanges = Partial<
  Pick<EmailRow, "date" | "emailReferences" | "messageId" | "read" | "starred">
>;

export interface MailboxStoreOptions {
  /** The most parameters one statement may bind. Tests pass a smaller number to force chunking. */
  maxBoundParams?: number;
  now?: () => Date;
}

const isoAgo = (now: Date, ms: number): string =>
  new Date(now.getTime() - ms).toISOString();

const splitAddresses = (value: string | null): string[] =>
  (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const chunked = <T>(items: T[], size: number): T[][] => {
  const parts: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    parts.push(items.slice(start, start + size));
  }
  return parts;
};

export const createMailboxStore = (
  db: MailboxDb,
  {
    maxBoundParams = DO_MAX_BOUND_PARAMS,
    now = () => new Date(),
  }: MailboxStoreOptions = {}
) => {
  /** Rows per attachment insert, one bound parameter per column. */
  const attachmentRowsPerInsert = Math.max(
    1,
    Math.floor(maxBoundParams / ATTACHMENT_COLUMNS)
  );
  /** Ids per `findThreadByIds` query: two `IN` lists and the `LIMIT` bind `2n + 1` parameters. */
  const threadIdsPerQuery = Math.max(1, Math.floor((maxBoundParams - 1) / 2));

  const insertAttachments = (
    tx: Pick<MailboxDb, "insert">,
    emailId: string,
    files: AttachmentInput[]
  ): void => {
    for (const part of chunked(files, attachmentRowsPerInsert)) {
      tx.insert(attachments)
        .values(part.map((file) => ({ ...file, emailId })))
        .run();
    }
  };

  const attachmentsOf = (emailIds: string[]): AttachmentRow[] =>
    chunked(emailIds, Math.max(1, maxBoundParams)).flatMap((part) =>
      db
        .select()
        .from(attachments)
        .where(inArray(attachments.emailId, part))
        .all()
    );

  const withAttachments = (rows: EmailRow[]): StoredEmail[] => {
    const byEmail = new Map<string, AttachmentRow[]>();
    for (const attachment of attachmentsOf(rows.map((row) => row.id))) {
      const list = byEmail.get(attachment.emailId) ?? [];
      list.push(attachment);
      byEmail.set(attachment.emailId, list);
    }
    return rows.map((row) => ({
      ...row,
      attachments: byEmail.get(row.id) ?? [],
    }));
  };

  const emailValues = (folder: FolderId, email: EmailInput) => ({
    ...email,
    folderId: folder,
    // The sender knows what they wrote, so sent mail and drafts never count as unread.
    read: folder === FOLDERS.sent || folder === FOLDERS.draft,
  });

  const getEmail = (id: string): StoredEmail | null => {
    const [row] = db.select().from(emails).where(eq(emails.id, id)).all();
    return row ? (withAttachments([row])[0] ?? null) : null;
  };

  const getThreadEmails = (threadId: string): StoredEmail[] =>
    withAttachments(
      db
        .select()
        .from(emails)
        .where(eq(emails.threadId, threadId))
        .orderBy(asc(emails.date), asc(emails.id))
        .all()
    );

  const findByDedupeKey = (key: string): InboundResult | null => {
    const [row] = db
      .select()
      .from(emails)
      .where(eq(emails.dedupeKey, key))
      .limit(1)
      .all();
    if (!row) {
      return null;
    }
    return {
      attachments: attachmentsOf([row.id]),
      duplicate: true,
      id: row.id,
      threadId: row.threadId ?? row.id,
    };
  };

  /** The thread of the newest stored mail whose `Message-ID` or thread id is one of `ids`. */
  const findThreadByIds = (ids: string[]): string | null => {
    let newest: { date: string; thread: string } | null = null;
    for (const part of chunked(ids, threadIdsPerQuery)) {
      const [row] = db
        .select({
          date: emails.date,
          id: emails.id,
          threadId: emails.threadId,
        })
        .from(emails)
        .where(
          or(inArray(emails.messageId, part), inArray(emails.threadId, part))
        )
        .orderBy(desc(emails.date))
        .limit(1)
        .all();
      if (row && (newest === null || (row.date ?? "") > newest.date)) {
        newest = { date: row.date ?? "", thread: row.threadId ?? row.id };
      }
    }
    return newest?.thread ?? null;
  };

  /**
   * A thread from the last 7 days with the same normalized subject that the
   * sender already took part in.
   */
  const findThreadBySubject = (
    subject: string,
    senderAddress: string
  ): string | null => {
    const normalized = normalizeSubject(subject);
    if (!normalized) {
      return null;
    }
    const cutoff = isoAgo(now(), SUBJECT_WINDOW_MS);
    const rows = db.all<{
      recipients: string | null;
      senders: string | null;
      subject: string | null;
      thread_id: string;
    }>(sql`
      SELECT thread_id, subject,
             GROUP_CONCAT(DISTINCT LOWER(sender)) AS senders,
             GROUP_CONCAT(DISTINCT LOWER(recipient)) AS recipients
      FROM emails
      WHERE thread_id IS NOT NULL
        AND thread_id != id
        AND date >= ${cutoff}
      GROUP BY thread_id
      ORDER BY MAX(date) DESC
      LIMIT ${THREAD_CANDIDATES}`);
    const sender = senderAddress.toLowerCase().trim();
    for (const row of rows) {
      if (normalizeSubject(row.subject ?? "") !== normalized) {
        continue;
      }
      const participants = splitAddresses(
        `${row.senders ?? ""},${row.recipients ?? ""}`
      );
      if (sender && !participants.includes(sender)) {
        continue;
      }
      return row.thread_id;
    }
    return null;
  };

  const threadReader: ThreadReader = { findThreadByIds, findThreadBySubject };

  const sentSince = (cutoff: string): number => {
    const [row] = db.all<{ cnt: number }>(sql`
      SELECT COUNT(*) AS cnt FROM emails
      WHERE folder_id = ${FOLDERS.sent} AND date >= ${cutoff}`);
    return row?.cnt ?? 0;
  };

  return {
    /** Null when the mailbox may send, else the reason it may not. */
    checkSendRateLimit: (): string | null => {
      const at = now();
      if (sentSince(isoAgo(at, HOUR_MS)) >= SEND_LIMIT_PER_HOUR) {
        return `Rate limit exceeded: max ${SEND_LIMIT_PER_HOUR} emails per hour per mailbox`;
      }
      if (sentSince(isoAgo(at, DAY_MS)) >= SEND_LIMIT_PER_DAY) {
        return `Rate limit exceeded: max ${SEND_LIMIT_PER_DAY} emails per day per mailbox`;
      }
      return null;
    },

    createEmail: (
      folder: FolderId,
      email: EmailInput,
      files: AttachmentInput[]
    ): void => {
      db.transaction((tx) => {
        tx.insert(emails).values(emailValues(folder, email)).run();
        insertAttachments(tx, email.id, files);
      });
    },

    /** Removes a mail and its attachment rows. Returns the attachments so the caller can delete their bytes. */
    deleteEmail: (id: string): AttachmentRow[] | null => {
      const existing = getEmail(id);
      if (!existing) {
        return null;
      }
      db.delete(emails).where(eq(emails.id, id)).run();
      return existing.attachments;
    },

    findByDedupeKey,
    findThreadByIds,
    findThreadBySubject,

    getAttachment: (id: string): AttachmentRow | null => {
      const [row] = db
        .select()
        .from(attachments)
        .where(eq(attachments.id, id))
        .all();
      return row ?? null;
    },

    getEmail,
    getThreadEmails,

    /**
     * Stores an inbound mail, resolving its thread. A mail whose dedupe key is
     * already stored changes nothing and returns the existing ids with
     * `duplicate: true`. The unique index decides, so a second delivery that
     * races the first lands here too.
     */
    insertInbound: (input: InboundInsert): InboundResult => {
      const { attachments: files, references, ...rest } = input;
      const threadId = resolveThreadId(threadReader, {
        inReplyTo: rest.inReplyTo,
        ownId: rest.id,
        references,
        sender: rest.sender,
        subject: rest.subject,
      });
      return db.transaction((tx) => {
        const inserted = tx
          .insert(emails)
          .values(
            emailValues(FOLDERS.inbox, {
              ...rest,
              bcc: null,
              emailReferences:
                references.length > 0 ? JSON.stringify(references) : null,
              threadId,
            })
          )
          .onConflictDoNothing()
          .returning({ id: emails.id })
          .all();
        if (inserted.length === 0) {
          const winner = findByDedupeKey(input.dedupeKey);
          if (winner) {
            return winner;
          }
          throw new Error(`Mail ${rest.id} was not stored`);
        }
        insertAttachments(tx, rest.id, files);
        return {
          attachments: files.map((file) => ({ ...file, emailId: rest.id })),
          duplicate: false,
          id: rest.id,
          threadId,
        };
      });
    },

    /** The threads of the mailbox without trash and spam, newest first. `page` starts at 1. */
    listThreads: (page: { limit: number; page: number }): ThreadSummary[] => {
      const limit = Math.min(Math.max(page.limit, 1), MAX_PAGE_SIZE);
      const offset = (Math.max(page.page, 1) - 1) * limit;
      const rows = db.all<{
        last_message_at: string;
        message_count: number;
        recipients: string | null;
        senders: string | null;
        subject: string | null;
        thread_id: string;
        unread_count: number;
      }>(sql`
        SELECT COALESCE(thread_id, id) AS thread_id,
               subject,
               MAX(date) AS last_message_at,
               COUNT(*) AS message_count,
               SUM(CASE WHEN COALESCE(read, 0) = 0 THEN 1 ELSE 0 END) AS unread_count,
               GROUP_CONCAT(DISTINCT sender) AS senders,
               GROUP_CONCAT(DISTINCT recipient) AS recipients
        FROM emails
        WHERE folder_id NOT IN (${FOLDERS.trash}, ${FOLDERS.spam})
        GROUP BY COALESCE(thread_id, id)
        ORDER BY last_message_at DESC, thread_id
        LIMIT ${limit} OFFSET ${offset}`);
      return rows.map((row) => ({
        lastMessageAt: row.last_message_at,
        messageCount: row.message_count,
        participants: [
          ...new Set([
            ...splitAddresses(row.senders),
            ...splitAddresses(row.recipients),
          ]),
        ],
        subject: row.subject ?? "",
        threadId: row.thread_id,
        unreadCount: row.unread_count,
      }));
    },

    /** Moves a mail to a folder. False when the mail does not exist. */
    moveEmail: (id: string, folder: FolderId): boolean => {
      const moved = db
        .update(emails)
        .set({ folderId: folder })
        .where(eq(emails.id, id))
        .returning({ id: emails.id })
        .all();
      return moved.length > 0;
    },

    /** Changes the fields of a sent or drafted mail that move with its delivery. */
    updateEmail: (id: string, changes: EmailChanges): StoredEmail | null => {
      if (Object.keys(changes).length > 0) {
        db.update(emails).set(changes).where(eq(emails.id, id)).run();
      }
      return getEmail(id);
    },
  };
};

export type MailboxStore = ReturnType<typeof createMailboxStore>;
