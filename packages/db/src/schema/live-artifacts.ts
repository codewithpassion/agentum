import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { ARTIFACT_MEMBER_ROLES } from "../shared.ts";
import { artifacts } from "./artifacts.ts";
import { runs } from "./runs.ts";
import { workspaces } from "./workspaces.ts";

export const guestIdentities = sqliteTable(
  "guest_identities",
  {
    createdAt: createdAt(),
    displayName: text("display_name").notNull(),
    email: text("email").notNull(),
    id: id(),
    lastSeenAt: text("last_seen_at"),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    uniqueIndex("guest_identities_email_unique").on(t.workspaceId, t.email),
    check("guest_email_lowercase", sql`${t.email} = lower(${t.email})`),
  ]
);

export const artifactMembers = sqliteTable(
  "artifact_members",
  {
    agentRunsPerDay: integer("agent_runs_per_day").notNull().default(20),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    createdAt: createdAt(),
    createdBy: text("created_by").notNull(),
    expiresAt: text("expires_at"),
    guestId: text("guest_id").references(() => guestIdentities.id),
    id: id(),
    principalKind: text("principal_kind", {
      enum: ["user", "guest"],
    }).notNull(),
    revokedAt: text("revoked_at"),
    revokedBy: text("revoked_by"),
    role: text("role", { enum: ARTIFACT_MEMBER_ROLES }).notNull(),
    userId: text("user_id"),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    uniqueIndex("artifact_members_user_unique")
      .on(t.artifactId, t.userId)
      .where(sql`${t.revokedAt} IS NULL`),
    uniqueIndex("artifact_members_guest_unique")
      .on(t.artifactId, t.guestId)
      .where(sql`${t.revokedAt} IS NULL`),
    check(
      "artifact_members_principal",
      sql`(${t.principalKind} = 'user' AND ${t.userId} IS NOT NULL AND ${t.guestId} IS NULL) OR (${t.principalKind} = 'guest' AND ${t.guestId} IS NOT NULL AND ${t.userId} IS NULL AND ${t.expiresAt} IS NOT NULL)`
    ),
    check("artifact_members_cap", sql`${t.agentRunsPerDay} >= 0`),
  ]
);

export const guestInvites = sqliteTable(
  "guest_invites",
  {
    createdAt: createdAt(),
    id: id(),
    memberId: text("member_id")
      .notNull()
      .references(() => artifactMembers.id),
    tokenHash: text("token_hash").notNull().unique(),
    usedAt: text("used_at"),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (_t) => []
);

export const guestCodes = sqliteTable(
  "guest_codes",
  {
    attempts: integer("attempts").notNull().default(0),
    codeHash: text("code_hash").notNull(),
    createdAt: createdAt(),
    expiresAt: text("expires_at").notNull(),
    guestId: text("guest_id")
      .notNull()
      .references(() => guestIdentities.id),
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    index("guest_codes_guest_idx").on(t.guestId),
    check(
      "guest_codes_attempts",
      sql`${t.attempts} >= 0 AND ${t.attempts} <= 5`
    ),
  ]
);

export const guestSessions = sqliteTable(
  "guest_sessions",
  {
    createdAt: createdAt(),
    expiresAt: text("expires_at").notNull(),
    guestId: text("guest_id")
      .notNull()
      .references(() => guestIdentities.id),
    id: id(),
    ipPrefix: text("ip_prefix"),
    lastUsedAt: text("last_used_at").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    userAgent: text("user_agent"),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [index("guest_sessions_guest_idx").on(t.guestId)]
);

export const artifactCommentThreads = sqliteTable(
  "artifact_comment_threads",
  {
    anchor: text("anchor"),
    answeredAt: text("answered_at"),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    id: id(),
    quote: text("quote"),
    resolvedAt: text("resolved_at"),
    resolvedBy: text("resolved_by"),
    toAgent: integer("to_agent", { mode: "boolean" }).notNull().default(false),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [index("artifact_comment_threads_artifact_idx").on(t.artifactId)]
);

export const artifactComments = sqliteTable(
  "artifact_comments",
  {
    authorId: text("author_id").notNull(),
    authorKind: text("author_kind", {
      enum: ["user", "guest", "agent"],
    }).notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
    deletedAt: text("deleted_at"),
    editedAt: text("edited_at"),
    id: id(),
    runId: text("run_id").references(() => runs.id),
    threadId: text("thread_id")
      .notNull()
      .references(() => artifactCommentThreads.id),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    index("artifact_comments_thread_idx").on(t.threadId),
    check(
      "artifact_comments_body_bytes",
      sql`length(CAST(${t.body} AS BLOB)) <= 4096`
    ),
  ]
);

export const artifactLiveChanges = sqliteTable(
  "artifact_live_changes",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    createdAt: createdAt(),
    id: id(),
    revertedAt: text("reverted_at"),
    revertedBy: text("reverted_by"),
    revFrom: integer("rev_from").notNull(),
    revTo: integer("rev_to").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    summary: text("summary").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    index("artifact_live_changes_artifact_idx").on(t.artifactId),
    check(
      "artifact_live_changes_revisions",
      sql`${t.revFrom} >= 0 AND ${t.revTo} > ${t.revFrom}`
    ),
  ]
);

/** Durable, at-least-once room access refresh. Kept after artifact deletion. */
export const artifactRoomInvalidations = sqliteTable(
  "artifact_room_invalidations",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    completedAt: text("completed_at"),
    createdAt: createdAt(),
    id: id(),
    participantId: text("participant_id"),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    index("artifact_room_invalidations_pending_idx").on(t.completedAt, t.id),
  ]
);

/** Dispatch intent commits with its addressed comment. Acknowledged after a durable run exists. */
export const artifactAskDispatches = sqliteTable(
  "artifact_ask_dispatches",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    authorId: text("author_id").notNull(),
    commentId: text("comment_id")
      .notNull()
      .unique()
      .references(() => artifactComments.id),
    completedAt: text("completed_at"),
    createdAt: createdAt(),
    id: id(),
    requestId: text("request_id").notNull(),
    runId: text("run_id").references(() => runs.id),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    uniqueIndex("artifact_ask_dispatches_request_unique").on(
      t.workspaceId,
      t.authorId,
      t.requestId
    ),
    index("artifact_ask_dispatches_pending_idx").on(t.completedAt, t.id),
  ]
);
