import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import {
  LIBRARY_ACCESS_MODES,
  LIBRARY_CONFLICT_STATUSES,
  LIBRARY_ENTRY_KINDS,
  LIBRARY_VERSION_OPS,
  WIKI_SUGGESTION_STATUSES,
} from "../shared.ts";
import { agents } from "./agents.ts";
import { runs } from "./runs.ts";
import { workspaces } from "./workspaces.ts";

/**
 * The path index of a workspace's library. Bytes live in R2 under
 * `${workspaceId}/library/${path}`; listing, stat and walks read this table.
 * Paths are normalised, with no leading slash, and the root is the empty path.
 */
export const libraryEntries = sqliteTable(
  "library_entries",
  {
    // R2 etag of the object. Null for a folder.
    etag: text("etag"),
    kind: text("kind", { enum: LIBRARY_ENTRY_KINDS }).notNull(),
    // ISO 8601 UTC.
    mtime: text("mtime").notNull(),
    // The folder holding this entry. The empty string for a top-level entry.
    parent: text("parent").notNull(),
    path: text("path").notNull(),
    // Bytes. 0 for a folder.
    size: integer("size").notNull(),
    updatedById: text("updated_by_id").notNull(),
    updatedByKind: text("updated_by_kind").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.path] }),
    index("library_entries_parent_idx").on(t.workspaceId, t.parent),
  ]
);

/**
 * One row per change to a library file, so history and restore work. The bytes
 * of a version live in R2 under `${workspaceId}/library-versions/<id>`, never
 * under the live key, because the next write replaces the live bytes. A delete
 * tombstone has no blob. `version` counts up per path. Versions are pruned past
 * `LIBRARY_VERSION_KEEP_DAYS` days, keeping the newest `LIBRARY_VERSION_KEEP_MIN`.
 */
export const libraryVersions = sqliteTable(
  "library_versions",
  {
    // `user` with a Clerk user id, or `agent` with an agent id.
    authorId: text("author_id").notNull(),
    authorKind: text("author_kind").notNull(),
    // Null for a delete tombstone.
    blobKey: text("blob_key"),
    createdAt: createdAt(),
    etag: text("etag").notNull(),
    id: id(),
    op: text("op", { enum: LIBRARY_VERSION_OPS }).notNull(),
    path: text("path").notNull(),
    // The run that made the change. Null for a person's.
    runId: text("run_id").references(() => runs.id),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
    version: integer("version").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    uniqueIndex("library_versions_path_version_unique").on(
      t.workspaceId,
      t.path,
      t.version
    ),
  ]
);

/**
 * What an agent's run may reach in the library, beyond its own home. The rule:
 * people read and write everything. An agent's run reads and writes its home
 * `agents/<slug>/`, reads `wiki/` and every `read` row here, writes every
 * `write` row, and nothing else. A grant covers its path and everything below
 * it. An agent without write access to a wiki page edits it through
 * `wiki_suggestions`.
 */
export const agentLibraryAccess = sqliteTable(
  "agent_library_access",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    createdAt: createdAt(),
    mode: text("mode", { enum: LIBRARY_ACCESS_MODES }).notNull(),
    // Normalised like `library_entries.path`: no leading or trailing slash.
    path: text("path").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.path] })]
);

/**
 * A write that lost a race: the daemon synced a file somebody else changed.
 * The agent's copy sits at `conflict_path` until a person resolves it.
 */
export const libraryConflicts = sqliteTable(
  "library_conflicts",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    conflictPath: text("conflict_path").notNull(),
    createdAt: createdAt(),
    id: id(),
    path: text("path").notNull(),
    // How a person settled it. Null while open.
    resolution: text("resolution"),
    resolvedAt: text("resolved_at"),
    runId: text("run_id").references(() => runs.id),
    status: text("status", { enum: LIBRARY_CONFLICT_STATUSES }).notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [index("library_conflicts_status_idx").on(t.workspaceId, t.status)]
);

/**
 * The wiki links a page contains, rebuilt whenever the page is saved.
 * `target` is the text as written, `target_key` the wiki page path it would
 * resolve to, whether or not that page exists yet.
 */
export const libraryLinks = sqliteTable(
  "library_links",
  {
    fromPath: text("from_path").notNull(),
    target: text("target").notNull(),
    targetKey: text("target_key").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.fromPath, t.target] }),
    index("library_links_target_idx").on(t.workspaceId, t.targetKey),
  ]
);

/**
 * An edit to a wiki page proposed by an agent that has no write access to it.
 * The proposed bytes live in R2 under `${workspaceId}/wiki-suggestions/<id>`.
 * A person accepts or rejects it. It goes `stale` once the page has moved on
 * from `base_version_id`.
 */
export const wikiSuggestions = sqliteTable(
  "wiki_suggestions",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    // The version the agent read. Null when the page did not exist yet.
    baseVersionId: text("base_version_id").references(() => libraryVersions.id),
    blobKey: text("blob_key").notNull(),
    createdAt: createdAt(),
    decidedAt: text("decided_at"),
    // Clerk user id.
    decidedBy: text("decided_by"),
    id: id(),
    path: text("path").notNull(),
    // The version an accepted suggestion wrote.
    resultVersionId: text("result_version_id").references(
      () => libraryVersions.id
    ),
    runId: text("run_id").references(() => runs.id),
    status: text("status", { enum: WIKI_SUGGESTION_STATUSES }).notNull(),
    summary: text("summary").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [index("wiki_suggestions_status_idx").on(t.workspaceId, t.status)]
);
