import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { MACHINE_STATUSES } from "../shared.ts";
import { workspaces } from "./workspaces.ts";

/** A machine belongs to one workspace. The relay alarm writes `status`. */
export const machines = sqliteTable("machines", {
  // JSON.
  capabilities: text("capabilities").notNull(),
  createdAt: createdAt(),
  credentialHash: text("credential_hash").notNull(),
  // Clerk user who enrolled the machine.
  enrolledBy: text("enrolled_by").notNull(),
  id: id(),
  lastSeenAt: text("last_seen_at"),
  name: text("name").notNull(),
  // Set when the daemon could not get a separate agent user.
  singleUser: integer("single_user", { mode: "boolean" }).notNull(),
  status: text("status", { enum: MACHINE_STATUSES }).notNull(),
  workspaceId: workspaceId().references(() => workspaces.id),
});

/** Single use, 15 minutes. */
export const machineEnrollTokens = sqliteTable(
  "machine_enroll_tokens",
  {
    createdAt: createdAt(),
    expiresAt: text("expires_at").notNull(),
    id: id(),
    machineName: text("machine_name").notNull(),
    tokenHash: text("token_hash").notNull(),
    usedAt: text("used_at"),
    workspaceId: workspaceId().references(() => workspaces.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [uniqueIndex("machine_enroll_tokens_hash_unique").on(t.tokenHash)]
);
