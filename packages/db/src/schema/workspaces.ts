import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";

/** Created on first request from a Clerk org. The only table with no workspace_id. */
export const workspaces = sqliteTable("workspaces", {
  clerkOrgId: text("clerk_org_id").notNull().unique(),
  createdAt: createdAt(),
  id: id(),
  name: text("name").notNull(),
  // The default timezone for routines.
  timezone: text("timezone").notNull(),
});

/** Maps an external (Slack) identity to a Clerk user; matched by email on first contact. */
export const identityLinks = sqliteTable(
  "identity_links",
  {
    clerkUserId: text("clerk_user_id").notNull(),
    createdAt: createdAt(),
    email: text("email").notNull(),
    externalUserId: text("external_user_id").notNull(),
    id: id(),
    provider: text("provider", { enum: ["slack"] }).notNull(),
    teamId: text("team_id").notNull(),
    workspaceId: workspaceId(),
  },
  (t) => [
    uniqueIndex("identity_links_identity_unique").on(
      t.workspaceId,
      t.provider,
      t.teamId,
      t.externalUserId
    ),
  ]
);
