// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Modified by Harbourmaster: the migration runner goes through drizzle, so it
// runs in a Durable Object and under bun:sqlite alike, and migration 9 is new.

import { sql } from "drizzle-orm";
import type { MailboxDb } from "./schema.ts";

export interface Migration {
  name: string;
  /** One statement per entry. A Durable Object cannot run SQL transactions. */
  statements: string[];
}

export const MAILBOX_MIGRATIONS: Migration[] = [
  {
    name: "1_initial_setup",
    statements: [
      `CREATE TABLE folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        is_deletable INTEGER NOT NULL DEFAULT 1
      )`,
      `INSERT INTO folders (id, name, is_deletable) VALUES
        ('inbox', 'Inbox', 0),
        ('sent', 'Sent', 0),
        ('trash', 'Trash', 0),
        ('archive', 'Archive', 0),
        ('spam', 'Spam', 0)`,
      `CREATE TABLE emails (
        id TEXT PRIMARY KEY,
        folder_id TEXT NOT NULL,
        subject TEXT,
        sender TEXT,
        recipient TEXT,
        date TEXT,
        read INTEGER DEFAULT 0,
        starred INTEGER DEFAULT 0,
        body TEXT,
        FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        email_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        mimetype TEXT NOT NULL,
        size INTEGER NOT NULL,
        content_id TEXT,
        disposition TEXT,
        FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
      )`,
    ],
  },
  {
    name: "2_add_email_threading",
    statements: [
      "ALTER TABLE emails ADD COLUMN in_reply_to TEXT",
      "ALTER TABLE emails ADD COLUMN email_references TEXT",
      "ALTER TABLE emails ADD COLUMN thread_id TEXT",
      "CREATE INDEX idx_emails_thread_id ON emails(thread_id)",
      "CREATE INDEX idx_emails_in_reply_to ON emails(in_reply_to)",
    ],
  },
  {
    name: "3_add_draft_folder",
    statements: [
      "INSERT INTO folders (id, name, is_deletable) VALUES ('draft', 'Drafts', 0)",
    ],
  },
  {
    name: "4_add_message_id",
    statements: ["ALTER TABLE emails ADD COLUMN message_id TEXT"],
  },
  {
    name: "5_add_raw_headers",
    statements: ["ALTER TABLE emails ADD COLUMN raw_headers TEXT"],
  },
  {
    name: "6_mark_sent_emails_as_read",
    statements: [
      "UPDATE emails SET read = 1 WHERE folder_id = 'sent' AND read = 0",
    ],
  },
  {
    name: "7_add_cc_bcc",
    statements: [
      "ALTER TABLE emails ADD COLUMN cc TEXT",
      "ALTER TABLE emails ADD COLUMN bcc TEXT",
    ],
  },
  {
    name: "8_add_folder_date_indexes",
    statements: [
      "CREATE INDEX IF NOT EXISTS idx_emails_folder_id ON emails(folder_id)",
      "CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date)",
      "CREATE INDEX IF NOT EXISTS idx_emails_folder_date ON emails(folder_id, date DESC)",
    ],
  },
  {
    // New in Harbourmaster. The unique index makes a second delivery of the
    // same mail a conflict instead of a second row.
    name: "9_add_dedupe_key_and_body_kind",
    statements: [
      "ALTER TABLE emails ADD COLUMN dedupe_key TEXT",
      "ALTER TABLE emails ADD COLUMN body_is_html INTEGER NOT NULL DEFAULT 0",
      "CREATE UNIQUE INDEX idx_emails_dedupe_key ON emails(dedupe_key) WHERE dedupe_key IS NOT NULL",
      "CREATE INDEX idx_emails_message_id ON emails(message_id)",
    ],
  },
];

/**
 * Applies the migrations that have not run yet, each in one transaction with
 * its bookkeeping row. Safe to call on every Durable Object start.
 */
export const applyMigrations = (
  db: MailboxDb,
  migrations: readonly Migration[] = MAILBOX_MIGRATIONS
): void => {
  db.run(
    sql`CREATE TABLE IF NOT EXISTS mailbox_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  );
  const applied = new Set(
    db
      .all<{ name: string }>(sql`SELECT name FROM mailbox_migrations`)
      .map((row) => row.name)
  );
  for (const migration of migrations) {
    if (applied.has(migration.name)) {
      continue;
    }
    db.transaction((tx) => {
      for (const statement of migration.statements) {
        tx.run(sql.raw(statement));
      }
      tx.run(
        sql`INSERT INTO mailbox_migrations (name) VALUES (${migration.name})`
      );
    });
  }
};
