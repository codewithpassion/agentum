import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import {
  ARTIFACT_AUDIENCES,
  ARTIFACT_AUTHOR_KINDS,
  ARTIFACT_GRANT_KINDS,
  ARTIFACT_GRANT_STATUSES,
  ARTIFACT_KINDS,
  ARTIFACT_PIN_SURFACES,
  ARTIFACT_SHARE_DATA_MODES,
  ARTIFACT_SHARE_KINDS,
  ARTIFACT_VERSION_STATUSES,
  ARTIFACT_VIEW_OUTCOMES,
  ARTIFACT_VIEW_SURFACES,
} from "../shared.ts";
import { agents } from "./agents.ts";
import { guestIdentities } from "./live-artifacts.ts";
import { runs } from "./runs.ts";
import { sessions } from "./sessions.ts";
import { workspaces } from "./workspaces.ts";

/**
 * An artifact: a page, doc, dashboard or app an agent or person made. The
 * files live in `artifact_versions` and `artifact_version_files`. Unlike other
 * tables, `id` is a random UUID made by the caller, because it appears in URLs.
 */
export const artifacts = sqliteTable(
  "artifacts",
  {
    agentId: text("agent_id").references(() => agents.id),
    audience: text("audience", { enum: ARTIFACT_AUDIENCES }).notNull(),
    convertedFromId: text("converted_from_id").references(
      (): AnySQLiteColumn => artifacts.id
    ),
    createdAt: createdAt(),
    // Clerk user id or agent id, see `created_by_kind`.
    createdById: text("created_by_id").notNull(),
    createdByKind: text("created_by_kind", {
      enum: ARTIFACT_AUTHOR_KINDS,
    }).notNull(),
    // The version members see. No foreign key: `artifact_versions` points back
    // at `artifacts`, and a cycle would block inserting either first.
    currentVersionId: text("current_version_id"),
    deletedAt: text("deleted_at"),
    deletedBy: text("deleted_by"),
    description: text("description"),
    // The one other agent that may update the artifact.
    handedToAgentId: text("handed_to_agent_id").references(() => agents.id),
    id: id(),
    kind: text("kind", { enum: ARTIFACT_KINDS }).notNull(),
    liveRoomRev: integer("live_room_rev"),
    // Clerk user id. Null: no person owns it.
    ownerUserId: text("owner_user_id"),
    runId: text("run_id").references(() => runs.id),
    sessionId: text("session_id").references(() => sessions.id),
    // R2 key.
    thumbnailKey: text("thumbnail_key"),
    title: text("title").notNull(),
    updatedAt: text("updated_at").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    index("artifacts_workspace_updated_idx").on(t.workspaceId, t.updatedAt),
  ]
);

/**
 * One publish: a full file tree, not a delta. `number` counts 1, 2, ... per
 * artifact, and the unique index on it refuses two publishes that raced on the
 * same base. `parent_number` is the version this one was made on, null for 1.
 */
export const artifactVersions = sqliteTable(
  "artifact_versions",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    // Agent id or Clerk user id, see `author_kind`.
    authorId: text("author_id").notNull(),
    authorKind: text("author_kind", { enum: ARTIFACT_AUTHOR_KINDS }).notNull(),
    // Set when an agent's run wrote the version.
    authorRunId: text("author_run_id"),
    createdAt: createdAt(),
    // The file the viewer opens first.
    entry: text("entry").notNull(),
    fileCount: integer("file_count").notNull(),
    id: id(),
    // `<ws>/artifact-manifests/<id>.json` in R2.
    manifestKey: text("manifest_key").notNull(),
    message: text("message").notNull(),
    number: integer("number").notNull(),
    // The number of the version this one was made on, null for version 1.
    parentNumber: integer("parent_number"),
    // The upstream commit an imported version came from. Null for a version written here.
    sourceCommitSha: text("source_commit_sha"),
    sourceLibraryPath: text("source_library_path"),
    status: text("status", { enum: ARTIFACT_VERSION_STATUSES }).notNull(),
    thumbnailKey: text("thumbnail_key"),
    totalBytes: integer("total_bytes").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    uniqueIndex("artifact_versions_number_unique").on(t.artifactId, t.number),
  ]
);

/**
 * A file of a version. Bytes live in R2 at `<ws>/artifact-blobs/<sha256>`,
 * written once and shared by every version that holds the same bytes.
 */
export const artifactVersionFiles = sqliteTable(
  "artifact_version_files",
  {
    contentType: text("content_type").notNull(),
    path: text("path").notNull(),
    // SHA-256, lower-case hex.
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
    versionId: text("version_id")
      .notNull()
      .references(() => artifactVersions.id),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [primaryKey({ columns: [t.versionId, t.path] })]
);

/**
 * A link that opens an artifact without a sign-in. Only the hash of the token
 * is looked up, the encrypted token is kept so the owner can copy the link
 * again. `version_id` null follows the current version.
 */
export const artifactShares = sqliteTable(
  "artifact_shares",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    createdAt: createdAt(),
    // Clerk user id.
    createdBy: text("created_by").notNull(),
    // `snapshot` or `live`.
    dataMode: text("data_mode", { enum: ARTIFACT_SHARE_DATA_MODES })
      .notNull()
      .default("snapshot"),
    expiresAt: text("expires_at"),
    // Clerk user id of the owner who made a live link, null for snapshot.
    grantedBy: text("granted_by"),
    id: id(),
    kind: text("kind", { enum: ARTIFACT_SHARE_KINDS }).notNull(),
    lastOpenedAt: text("last_opened_at"),
    // JSON array of tool keys a live link may call, null for snapshot.
    liveTools: text("live_tools"),
    openCount: integer("open_count").notNull().default(0),
    revokedAt: text("revoked_at"),
    revokedBy: text("revoked_by"),
    // AES-GCM under SECRETS_KEY.
    tokenEncrypted: text("token_encrypted").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    versionId: text("version_id").references(() => artifactVersions.id),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [index("artifact_shares_artifact_idx").on(t.artifactId)]
);

/**
 * One open of an artifact, from a member, a link or a test. Never a full IP:
 * `ip_prefix` and `visitor_hash` (salted per day) stand in for it.
 */
export const artifactViews = sqliteTable(
  "artifact_views",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    asn: text("asn"),
    asOrg: text("as_org"),
    city: text("city"),
    country: text("country"),
    createdAt: createdAt(),
    guestId: text("guest_id").references(
      (): AnySQLiteColumn => guestIdentities.id
    ),
    id: id(),
    ipPrefix: text("ip_prefix"),
    outcome: text("outcome", { enum: ARTIFACT_VIEW_OUTCOMES }).notNull(),
    referrerHost: text("referrer_host"),
    region: text("region"),
    shareId: text("share_id").references(() => artifactShares.id),
    surface: text("surface", { enum: ARTIFACT_VIEW_SURFACES }).notNull(),
    // Set for `live_call` rows.
    toolKey: text("tool_key"),
    userAgent: text("user_agent"),
    // Clerk user id.
    userId: text("user_id"),
    versionId: text("version_id").references(() => artifactVersions.id),
    visitorHash: text("visitor_hash"),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    index("artifact_views_artifact_idx").on(t.artifactId, t.createdAt),
    index("artifact_views_share_idx").on(t.shareId, t.createdAt),
  ]
);

/** The salt that hashes visitors for one day. A tick job deletes old rows. */
export const artifactViewSalts = sqliteTable(
  "artifact_view_salts",
  {
    // UTC date, `YYYY-MM-DD`.
    day: text("day").notNull(),
    salt: text("salt").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.day] })]
);

/** A permission a version asks for (a tool, a secret or a host), decided by a person. */
export const artifactGrants = sqliteTable(
  "artifact_grants",
  {
    createdAt: createdAt(),
    decidedAt: text("decided_at"),
    // Clerk user id.
    decidedBy: text("decided_by"),
    id: id(),
    kind: text("kind", { enum: ARTIFACT_GRANT_KINDS }).notNull(),
    status: text("status", { enum: ARTIFACT_GRANT_STATUSES }).notNull(),
    target: text("target").notNull(),
    versionId: text("version_id")
      .notNull()
      .references(() => artifactVersions.id),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [index("artifact_grants_version_idx").on(t.versionId)]
);

/** An artifact a person pinned to their sidebar or desk. */
export const artifactPins = sqliteTable(
  "artifact_pins",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    createdAt: createdAt(),
    id: id(),
    position: integer("position").notNull(),
    surface: text("surface", { enum: ARTIFACT_PIN_SURFACES }).notNull(),
    // Clerk user id.
    userId: text("user_id").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    uniqueIndex("artifact_pins_unique").on(t.userId, t.artifactId, t.surface),
  ]
);

/** Stable public endpoint ids; rotating retains disabled rows for history. */
export const artifactEndpoints = sqliteTable(
  "artifact_endpoints",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    createdAt: createdAt(),
    disabledAt: text("disabled_at"),
    id: id(),
    name: text("name").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    uniqueIndex("artifact_endpoints_active_name_unique")
      .on(t.artifactId, t.name)
      .where(sql`${t.disabledAt} IS NULL`),
  ]
);
