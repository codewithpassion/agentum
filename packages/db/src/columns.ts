// Column builders every foundation table shares. Not in schema/ because
// drizzle-kit loads every file there as a table module.
import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, text } from "drizzle-orm/sqlite-core";

/** Ids are ULIDs stored as text. */
export const id = () => text("id").primaryKey();

/**
 * The tenant scope. NOT NULL with no default, so an insert that forgets the
 * workspace fails instead of landing in a shared bucket.
 */
export const workspaceId = () => text("workspace_id").notNull();

/** ISO 8601 UTC. */
export const createdAt = () => text("created_at").notNull();

/** A row has an agent or a team, never both and never neither. For a `check`. */
export const ownerCheck = (agentId: AnySQLiteColumn, teamId: AnySQLiteColumn) =>
  sql`(${agentId} is null) <> (${teamId} is null)`;
