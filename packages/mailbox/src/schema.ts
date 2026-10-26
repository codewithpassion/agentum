// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Modified by Harbourmaster: camelCase keys, boolean columns, the
// `dedupe_key` and `body_is_html` columns, and no API key table.

import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * A mailbox's own drizzle instance. Both `drizzle-orm/durable-sqlite` (the
 * Durable Object) and `drizzle-orm/bun-sqlite` (the tests) are synchronous, so
 * one type covers them.
 */
export type MailboxDb = BaseSQLiteDatabase<"sync", unknown>;

export const folders = sqliteTable("folders", {
  id: text("id").primaryKey(),
  isDeletable: integer("is_deletable").notNull().default(1),
  name: text("name").notNull().unique(),
});

export const emails = sqliteTable("emails", {
  bcc: text("bcc"),
  body: text("body"),
  /** 1 when `body` is HTML, 0 when it is plain text. */
  bodyIsHtml: integer("body_is_html", { mode: "boolean" })
    .notNull()
    .default(false),
  cc: text("cc"),
  date: text("date"),
  /** The RFC `Message-ID` of an inbound mail, or `sha256:<hex>` when it has none. Null on outbound rows. */
  dedupeKey: text("dedupe_key"),
  emailReferences: text("email_references"),
  folderId: text("folder_id")
    .notNull()
    .references(() => folders.id, { onDelete: "cascade" }),
  id: text("id").primaryKey(),
  inReplyTo: text("in_reply_to"),
  messageId: text("message_id"),
  rawHeaders: text("raw_headers"),
  read: integer("read", { mode: "boolean" }).default(false),
  recipient: text("recipient"),
  sender: text("sender"),
  starred: integer("starred", { mode: "boolean" }).default(false),
  subject: text("subject"),
  threadId: text("thread_id"),
});

export const attachments = sqliteTable("attachments", {
  contentId: text("content_id"),
  disposition: text("disposition"),
  emailId: text("email_id")
    .notNull()
    .references(() => emails.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  id: text("id").primaryKey(),
  mimetype: text("mimetype").notNull(),
  size: integer("size").notNull(),
});
