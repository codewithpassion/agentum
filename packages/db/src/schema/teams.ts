import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { TEAM_MEMBER_KINDS } from "../shared.ts";
import { agents } from "./agents.ts";
import { workspaces } from "./workspaces.ts";

/**
 * A team: a lead, members and a team room. The room is the forum inbox scoped
 * to the team (`inbox_threads.team_id`). Every workspace has an "Everyone"
 * team with no lead, which holds the threads made before teams existed.
 */
export const teams = sqliteTable(
  "teams",
  {
    // ISO 8601 UTC. NULL while the team is live.
    archivedAt: text("archived_at"),
    createdAt: createdAt(),
    // The library folder the team's files live in. NULL before one exists.
    folderPath: text("folder_path"),
    id: id(),
    // The agent that leads the team. NULL for a team with no lead.
    leadAgentId: text("lead_agent_id").references(() => agents.id),
    // Whether a room message that names nobody goes to the lead.
    leadListens: integer("lead_listens", { mode: "boolean" })
      .notNull()
      .default(true),
    name: text("name").notNull(),
    // Clerk user id of the person who answers for the team. NULL for none.
    ownerUserId: text("owner_user_id"),
    // Shown to every member above the untrusted block of a prompt.
    rules: text("rules").notNull().default(""),
    slug: text("slug").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [uniqueIndex("teams_slug_unique").on(t.workspaceId, t.slug)]
);

/** Who is in a team. An agent may be in several teams, with one home team. */
export const teamMembers = sqliteTable(
  "team_members",
  {
    isHome: integer("is_home", { mode: "boolean" }).notNull().default(false),
    // The agent id or the Clerk user id, by `member_kind`.
    memberId: text("member_id").notNull(),
    memberKind: text("member_kind", { enum: TEAM_MEMBER_KINDS }).notNull(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.memberKind, t.memberId] }),
    index("team_members_member_idx").on(t.memberKind, t.memberId),
  ]
);

/** How a person is named and mentioned in team rooms. */
export const memberProfiles = sqliteTable(
  "member_profiles",
  {
    // Lowercase, unique per workspace.
    handle: text("handle").notNull(),
    name: text("name").notNull(),
    // Clerk user id.
    userId: text("user_id").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    uniqueIndex("member_profiles_handle_unique").on(t.workspaceId, t.handle),
  ]
);
