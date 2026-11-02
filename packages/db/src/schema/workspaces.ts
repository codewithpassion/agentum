import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { IDENTITY_PROVIDERS } from "../shared.ts";

/** One row per Clerk org that has access. Made by the add-workspace script or the create-workspace screen. The only table with no workspace_id. */
export const workspaces = sqliteTable("workspaces", {
  // 0 stops the workspace from making public artifact links.
  artifactLinksEnabled: integer("artifact_links_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
  clerkOrgId: text("clerk_org_id").notNull().unique(),
  createdAt: createdAt(),
  id: id(),
  liveGuestsEnabled: integer("live_guests_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
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
    provider: text("provider", { enum: IDENTITY_PROVIDERS }).notNull(),
    teamId: text("team_id").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id, {
      onDelete: "cascade",
    }),
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
