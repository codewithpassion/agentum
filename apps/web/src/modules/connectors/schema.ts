import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

/**
 * Foundation for the connector layer (Slack first, phase 2): maps an external
 * surface's identifier onto an internal channel/message/author. No connector
 * logic ships yet - only the mapping table it will need.
 */
export const externalRefs = sqliteTable(
  "external_refs",
  {
    /** e.g. `slack`. */
    connector: text("connector").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    /** e.g. a Slack channel id, message `ts`, or user id. */
    externalId: text("external_id").notNull(),
    id: text("id").primaryKey(),
    internalId: text("internal_id").notNull(),
    /** e.g. `channel`, `message`, `author`. */
    internalType: text("internal_type").notNull(),
  },
  (table) => [
    unique("external_refs_connector_external_idx").on(
      table.connector,
      table.internalType,
      table.externalId
    ),
  ]
);

export type ExternalRef = typeof externalRefs.$inferSelect;
