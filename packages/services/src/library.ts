/**
 * The workspace library (F.1). One tree of files per workspace. Bytes live in
 * blob storage under `${workspaceId}/library/${path}`, and the `library_entries`
 * table indexes them, so listing, `stat` and walks never touch R2. Only reads
 * and writes of file bytes do.
 *
 * People read and write everything. Runs read their home, wiki and granted
 * folders, and write their home and write grants. canReadAt and canWriteAt
 * apply the same resolved scope to every entry point. list and stat also let a
 * run traverse a folder above a grant (canTraverse).
 *
 * The blob store is the source of truth for bytes and etags. A write lands in
 * the store first, then the row and the event land together through `atomic`.
 * If that second step fails, the object stays and the next write repairs the
 * row.
 */
import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { libraryEntries, libraryVersions } from "@repo/db/schema/library";
import type { LibraryAccessGrant } from "@repo/db/shared";
import {
  LIBRARY_FILE_MAX_BYTES,
  LIBRARY_MAX_BYTES,
  type LibraryChange,
  type LibraryEntryKind,
} from "@repo/db/shared";
import { isConflictPath } from "@repo/library-sync/types";
import { and, asc, eq, gte, inArray, like, lt, or, sql } from "drizzle-orm";
import { authorize, ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import { agentGrants } from "./library/access.ts";
import { ancestorsOf, normalizePath, parentOf } from "./library/path.ts";
import { librarySyncScope } from "./library/sync-paths.ts";
import {
  compareVersionBytes,
  createVersionStore,
  type VersionRow,
} from "./library/versions.ts";
import type { Clock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

const LIBRARY_KIND = "library";
const ROOT = "";
const EPOCH = "1970-01-01T00:00:00.000Z";
/** D1 binds at most 100 parameters per statement, and a row binds 9. */
const ROWS_PER_INSERT = 10;

/** Blob storage: R2 in the app, a Map in tests. Keys are full object keys. */
export interface LibraryBlobs {
  /** Removes the objects. A key with no object is not an error. */
  delete: (keys: readonly string[]) => Promise<void>;
  get: (key: string) => Promise<{ bytes: Uint8Array; etag: string } | null>;
  /**
   * Stores the bytes and returns the new etag. With `ifEtag` the store keeps
   * the object only if it exists with that etag, and returns null otherwise.
   */
  put: (
    key: string,
    bytes: Uint8Array,
    options?: { ifEtag?: string }
  ) => Promise<{ etag: string } | null>;
}

export interface LibraryEntry {
  /** Null for a folder. */
  etag: string | null;
  kind: LibraryEntryKind;
  mtime: string;
  /** No leading slash. The root is the empty string. */
  path: string;
  size: number;
  updatedBy: { id: string; kind: "agent" | "user" };
}

type EntryRow = typeof libraryEntries.$inferSelect;
type Member = Extract<Principal, { kind: "run" | "user" }>;

const notFound = () => new ServiceError("not_found", "Not found");
const invalid = (message: string) => new ServiceError("invalid", message);

const toEntry = (row: EntryRow): LibraryEntry => ({
  etag: row.etag,
  kind: row.kind,
  mtime: row.mtime,
  path: row.path,
  size: row.size,
  updatedBy: {
    id: row.updatedById,
    kind: row.updatedByKind === "agent" ? "agent" : "user",
  },
});

/** Users and runs work in the library. Machines, triggers and the tick do not. */
const requireMember = (principal: Principal, action: string): Member => {
  if (principal.kind !== "user" && principal.kind !== "run") {
    throw new ForbiddenError(action);
  }
  return principal;
};

/** Writing is for a person or a run. A read-only API key or OAuth client only reads. */
const requireWriter = (principal: Principal, action: string): Member => {
  const member = requireMember(principal, action);
  if (
    member.kind === "user" &&
    (member.apiKey?.access === "read" || member.oauthClient?.access === "read")
  ) {
    throw new ForbiddenError(action);
  }
  return member;
};

type AccessMember = Member & { scope?: LibraryAccessGrant[] };
const within = (path: string, root: string) =>
  path === root || path.startsWith(`${root}/`);
const canWriteAt = (member: AccessMember, path: string): boolean =>
  member.kind === "user" ||
  (member.scope ?? []).some(
    (root) => root.mode === "write" && within(path, root.path)
  );
// Contents, history and conflict names need a root that covers the path.
const canReadAt = (member: AccessMember, path: string): boolean =>
  member.kind === "user" ||
  path === "" ||
  (member.scope ?? []).some((root) => within(path, root.path));
// A folder above a root is traversable so the root can be found. A file there is not.
const canTraverse = (member: AccessMember, path: string): boolean =>
  canReadAt(member, path) ||
  (member.scope ?? []).some((root) => within(root.path, path));

const actorOf = (member: Member): { id: string; kind: "agent" | "user" } =>
  member.kind === "user"
    ? { id: member.userId, kind: "user" }
    : { id: member.agentId, kind: "agent" };

const objectKey = (workspaceId: string, path: string): string =>
  `${workspaceId}/library/${path}`;

/** The rows of a folder's subtree, not the folder itself. */
const underFolder = (workspaceId: string, path: string) =>
  and(
    eq(libraryEntries.workspaceId, workspaceId),
    gte(libraryEntries.path, `${path}/`),
    // "0" is the character after "/", so this is every path starting "path/".
    lt(libraryEntries.path, `${path}0`)
  );

/** The paths of a move: neither is the root, neither holds the other, the member may write both. */
const checkMovePaths = (
  member: AccessMember,
  from: string,
  to: string
): void => {
  if (from === ROOT || to === ROOT) {
    throw invalid("The library root cannot be moved");
  }
  if (to === from || to.startsWith(`${from}/`)) {
    throw invalid("A path cannot move into itself");
  }
  if (!(canWriteAt(member, from) && canWriteAt(member, to))) {
    throw new ForbiddenError("library.move");
  }
};

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
};

export const createLibraryService = ({
  atomic,
  blobs,
  clock,
  db,
  events,
  notify,
}: {
  notify?: (change: LibraryChange) => void | Promise<void>;
  atomic: Atomic;
  blobs: LibraryBlobs;
  clock: Clock;
  db: Database;
  events: Pick<EventsService, "insertStatement">;
}) => {
  const history = createVersionStore({ atomic, blobs, db });
  const resolveMember = async (member: Member): Promise<AccessMember> => {
    if (member.kind === "user") {
      return member;
    }
    const [[agent], grants] = await Promise.all([
      db
        .select({ slug: agents.slug })
        .from(agents)
        .where(
          and(
            eq(agents.id, member.agentId),
            eq(agents.workspaceId, member.workspaceId)
          )
        )
        .limit(1),
      agentGrants(db, member.workspaceId, member.agentId),
    ]);
    return {
      ...member,
      scope: agent ? librarySyncScope(agent.slug, grants) : [],
    };
  };

  /** Runs after the commit, so a failing listener must not fail the change. */
  const changed = async (member: Member, paths: string[]) => {
    try {
      await notify?.({
        byRunId: member.kind === "run" ? member.runId : null,
        paths,
        workspaceId: member.workspaceId,
      });
    } catch {
      // The change is already committed. V4.6 wires the listener and owns its retry.
    }
  };
  const versionOf = (
    member: Member,
    row: EntryRow,
    version: number,
    op: VersionRow["op"],
    bytes: Uint8Array | null
  ) =>
    history.row(
      {
        authorId: actorOf(member).id,
        authorKind: actorOf(member).kind,
        createdAt: row.mtime,
        etag: row.etag ?? "",
        op,
        path: row.path,
        runId: member.kind === "run" ? member.runId : null,
        size: bytes?.byteLength ?? 0,
        version,
        workspaceId: member.workspaceId,
      },
      bytes
    );
  const historyMember = async (principal: Principal, action: string) => {
    const member = requireMember(principal, action);
    authorize(member, action, {
      kind: LIBRARY_KIND,
      workspaceId: member.workspaceId,
    });
    return await resolveMember(member);
  };
  const versions = async (principal: Principal, rawPath: string) => {
    const member = await historyMember(principal, "library.read");
    // History is newest first and remains readable after deletion.
    const path = normalizePath(rawPath);
    if (!canReadAt(member, path)) {
      throw notFound();
    }
    return await history.list(member.workspaceId, path);
  };
  const readVersion = async (principal: Principal, id: string) => {
    const member = await historyMember(principal, "library.read");
    const version = await history.get(member.workspaceId, id);
    if (!canReadAt(member, version.path)) {
      throw notFound();
    }
    return await history.read(member.workspaceId, id);
  };
  const compare = async (principal: Principal, a: string, b: string) => {
    const [left, right] = await Promise.all([
      readVersion(principal, a),
      readVersion(principal, b),
    ]);
    return compareVersionBytes(left.bytes, right.bytes);
  };
  const entryAt = async (
    workspaceId: string,
    path: string
  ): Promise<EntryRow | null> => {
    const [row] = await db
      .select()
      .from(libraryEntries)
      .where(
        and(
          eq(libraryEntries.workspaceId, workspaceId),
          eq(libraryEntries.path, path)
        )
      )
      .limit(1);
    return row ?? null;
  };

  const subtree = (workspaceId: string, path: string): Promise<EntryRow[]> =>
    db
      .select()
      .from(libraryEntries)
      .where(underFolder(workspaceId, path))
      .orderBy(asc(libraryEntries.path));

  const libraryBytes = async (workspaceId: string): Promise<number> => {
    const [row] = await db
      .select({
        total: sql<number>`coalesce(sum(${libraryEntries.size}), 0)`,
      })
      .from(libraryEntries)
      .where(
        and(
          eq(libraryEntries.workspaceId, workspaceId),
          eq(libraryEntries.kind, "file")
        )
      );
    return Number(row?.total ?? 0);
  };

  /** Refuses when a folder above `path` is a file. Returns the folders still to create. */
  const missingFolders = async (
    workspaceId: string,
    path: string
  ): Promise<string[]> => {
    const folders = ancestorsOf(path);
    if (folders.length === 0) {
      return [];
    }
    const rows = await db
      .select()
      .from(libraryEntries)
      .where(
        and(
          eq(libraryEntries.workspaceId, workspaceId),
          inArray(libraryEntries.path, folders)
        )
      );
    if (rows.some((row) => row.kind === "file")) {
      throw invalid("A file is in the way of this path");
    }
    const present = new Set(rows.map((row) => row.path));
    return folders.filter((folder) => !present.has(folder));
  };

  const rowOf = (
    member: Member,
    path: string,
    fields: { etag: string | null; kind: LibraryEntryKind; size: number }
  ): EntryRow => {
    const actor = actorOf(member);
    return {
      ...fields,
      mtime: clock.now().toISOString(),
      parent: parentOf(path),
      path,
      updatedById: actor.id,
      updatedByKind: actor.kind,
      workspaceId: member.workspaceId,
    };
  };

  const folderStatements = (member: Member, folders: string[]): Statement[] =>
    chunks(
      folders.map((folder) =>
        rowOf(member, folder, { etag: null, kind: "dir", size: 0 })
      ),
      ROWS_PER_INSERT
    ).map((rows) =>
      db.insert(libraryEntries).values(rows).onConflictDoNothing()
    );

  const eventStatement = (
    member: Member,
    type: "library.delete" | "library.write" | "library.restore",
    path: string,
    size: number
  ): Statement =>
    events.insertStatement({
      actor: actorOf(member),
      agentId: member.kind === "run" ? member.agentId : undefined,
      payload: { path, size },
      runId: member.kind === "run" ? member.runId : undefined,
      type,
      workspaceId: member.workspaceId,
    });

  const list = async (
    principal: Principal,
    dir: string
  ): Promise<LibraryEntry[]> => {
    const member = await resolveMember(
      requireMember(principal, "library.list")
    );
    authorize(member, "library.list", {
      kind: LIBRARY_KIND,
      workspaceId: member.workspaceId,
    });
    const path = normalizePath(dir);
    if (!canTraverse(member, path)) {
      throw notFound();
    }
    if (path !== ROOT) {
      const folder = await entryAt(member.workspaceId, path);
      if (folder?.kind !== "dir") {
        throw notFound();
      }
    }
    const rows = await db
      .select()
      .from(libraryEntries)
      .where(
        and(
          eq(libraryEntries.workspaceId, member.workspaceId),
          eq(libraryEntries.parent, path)
        )
      )
      .orderBy(asc(libraryEntries.path));
    return rows
      .filter(
        (row) =>
          canReadAt(member, row.path) ||
          (row.kind === "dir" && canTraverse(member, row.path))
      )
      .map(toEntry);
  };

  /** The root has no row. It reads as an empty-handed folder dated at the epoch. */
  const stat = async (
    principal: Principal,
    rawPath: string
  ): Promise<LibraryEntry> => {
    const member = await resolveMember(
      requireMember(principal, "library.stat")
    );
    authorize(member, "library.stat", {
      kind: LIBRARY_KIND,
      workspaceId: member.workspaceId,
    });
    const path = normalizePath(rawPath);
    if (!canTraverse(member, path)) {
      throw notFound();
    }
    if (path === ROOT) {
      return {
        etag: null,
        kind: "dir",
        mtime: EPOCH,
        path,
        size: 0,
        updatedBy: { id: "system", kind: "user" },
      };
    }
    const row = await entryAt(member.workspaceId, path);
    if (!row || (row.kind !== "dir" && !canReadAt(member, path))) {
      throw notFound();
    }
    return toEntry(row);
  };

  const read = async (
    principal: Principal,
    rawPath: string
  ): Promise<{ bytes: Uint8Array; entry: LibraryEntry }> => {
    const member = await resolveMember(
      requireMember(principal, "library.read")
    );
    authorize(member, "library.read", {
      kind: LIBRARY_KIND,
      workspaceId: member.workspaceId,
    });
    const path = normalizePath(rawPath);
    if (!canReadAt(member, path)) {
      throw notFound();
    }
    const row = await entryAt(member.workspaceId, path);
    if (!row) {
      throw notFound();
    }
    if (row.kind === "dir") {
      throw invalid("Path is a folder");
    }
    const object = await blobs.get(objectKey(member.workspaceId, path));
    if (!object) {
      throw notFound();
    }
    return {
      bytes: object.bytes,
      entry: {
        ...toEntry(row),
        etag: object.etag,
        size: object.bytes.byteLength,
      },
    };
  };

  const writeFile = async (
    principal: Principal,
    rawPath: string,
    bytes: Uint8Array,
    options: { ifEtag?: string } = {},
    op: "write" | "restore" = "write"
  ): Promise<LibraryEntry> => {
    const member = await resolveMember(
      requireWriter(principal, "library.write")
    );
    authorize(member, "library.write", {
      kind: LIBRARY_KIND,
      workspaceId: member.workspaceId,
    });
    const path = normalizePath(rawPath);
    if (path === ROOT) {
      throw invalid("The library root is a folder");
    }
    if (!canWriteAt(member, path)) {
      throw new ForbiddenError("library.write");
    }
    if (bytes.byteLength > LIBRARY_FILE_MAX_BYTES) {
      throw invalid("Library files are limited to 10 MB");
    }
    const existing = await entryAt(member.workspaceId, path);
    if (existing?.kind === "dir") {
      throw invalid("Path is a folder");
    }
    const folders = await missingFolders(member.workspaceId, path);
    const used = await libraryBytes(member.workspaceId);
    if (used - (existing?.size ?? 0) + bytes.byteLength > LIBRARY_MAX_BYTES) {
      throw invalid("The library is limited to 1 GB");
    }
    const seeds = await history.seed(existing);
    const previous = await history.list(member.workspaceId, path);
    const stored = await blobs.put(
      objectKey(member.workspaceId, path),
      bytes,
      options.ifEtag === undefined ? undefined : { ifEtag: options.ifEtag }
    );
    if (!stored) {
      throw new ServiceError("conflict", "The file changed since it was read");
    }
    const row = rowOf(member, path, {
      etag: stored.etag,
      kind: "file",
      size: bytes.byteLength,
    });
    const version = await versionOf(
      member,
      row,
      (previous[0]?.version ?? seeds[0]?.version ?? 0) + 1,
      op,
      bytes
    );
    await atomic([
      ...seeds.map(history.insertSeed),
      history.insertNext(version),
      ...folderStatements(member, folders),
      db
        .insert(libraryEntries)
        .values(row)
        .onConflictDoUpdate({
          set: {
            etag: row.etag,
            mtime: row.mtime,
            size: row.size,
            updatedById: row.updatedById,
            updatedByKind: row.updatedByKind,
          },
          target: [libraryEntries.workspaceId, libraryEntries.path],
        }),
      eventStatement(
        member,
        op === "restore" ? "library.restore" : "library.write",
        path,
        row.size
      ),
    ]);
    await changed(member, [path]);
    return toEntry(row);
  };

  const write = (
    principal: Principal,
    path: string,
    bytes: Uint8Array,
    options: { ifEtag?: string } = {}
  ) => writeFile(principal, path, bytes, options);
  const restore = async (
    principal: Principal,
    versionId: string,
    options: { ifEtag?: string } = {}
  ) => {
    requireWriter(principal, "library.restore");
    const { bytes, version } = await readVersion(principal, versionId);
    return writeFile(principal, version.path, bytes, options, "restore");
  };

  const mkdir = async (
    principal: Principal,
    rawPath: string
  ): Promise<LibraryEntry> => {
    const member = await resolveMember(
      requireWriter(principal, "library.mkdir")
    );
    authorize(member, "library.mkdir", {
      kind: LIBRARY_KIND,
      workspaceId: member.workspaceId,
    });
    const path = normalizePath(rawPath);
    if (path === ROOT) {
      throw invalid("The library root exists");
    }
    if (!canWriteAt(member, path)) {
      throw new ForbiddenError("library.mkdir");
    }
    const existing = await entryAt(member.workspaceId, path);
    if (existing) {
      if (existing.kind === "file") {
        throw invalid("A file is in the way of this path");
      }
      return toEntry(existing);
    }
    const folders = await missingFolders(member.workspaceId, path);
    await atomic(folderStatements(member, [...folders, path]));
    const created = await entryAt(member.workspaceId, path);
    if (!created) {
      throw notFound();
    }
    return toEntry(created);
  };

  const remove = async (
    principal: Principal,
    rawPath: string,
    options: { recursive?: boolean } = {}
  ): Promise<void> => {
    const member = await resolveMember(
      requireWriter(principal, "library.delete")
    );
    authorize(member, "library.delete", {
      kind: LIBRARY_KIND,
      workspaceId: member.workspaceId,
    });
    const path = normalizePath(rawPath);
    if (path === ROOT) {
      throw invalid("The library root cannot be removed");
    }
    if (!canWriteAt(member, path)) {
      throw new ForbiddenError("library.delete");
    }
    const row = await entryAt(member.workspaceId, path);
    if (!row) {
      throw notFound();
    }
    const below =
      row.kind === "dir" ? await subtree(row.workspaceId, path) : [];
    if (below.length > 0 && options.recursive !== true) {
      throw new ServiceError("conflict", "The folder is not empty");
    }
    const removed = [row, ...below];
    const versionStatements: Statement[] = [];
    for (const entry of removed.filter((item) => item.kind === "file")) {
      // biome-ignore lint/performance/noAwaitInLoops: snapshot one file at a time
      const seeds = await history.seed(entry);
      const previous = await history.list(member.workspaceId, entry.path);
      const tombstone = await versionOf(
        member,
        { ...entry, mtime: clock.now().toISOString() },
        (previous[0]?.version ?? seeds[0]?.version ?? 0) + 1,
        "delete",
        null
      );
      versionStatements.push(
        ...seeds.map(history.insertSeed),
        history.insertNext(tombstone)
      );
    }
    const size = removed.reduce((total, entry) => total + entry.size, 0);
    await atomic([
      ...versionStatements,
      db
        .delete(libraryEntries)
        .where(
          or(
            and(
              eq(libraryEntries.workspaceId, member.workspaceId),
              eq(libraryEntries.path, path)
            ),
            underFolder(member.workspaceId, path)
          )
        ),
      eventStatement(member, "library.delete", path, size),
    ]);
    await changed(
      member,
      removed.map((entry) => entry.path)
    );
    const keys = removed
      .filter((entry) => entry.kind === "file")
      .map((entry) => objectKey(member.workspaceId, entry.path));
    await blobs.delete(keys);
  };

  /** Copies each file's bytes to its new key and returns the rows for the new paths. */
  const copyRows = async (
    member: Member,
    sources: readonly EntryRow[],
    from: string,
    to: string
  ): Promise<EntryRow[]> => {
    const copied: EntryRow[] = [];
    for (const source of sources) {
      const path = `${to}${source.path.slice(from.length)}`;
      if (source.kind === "dir") {
        copied.push(rowOf(member, path, { etag: null, kind: "dir", size: 0 }));
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: one file in memory at a time
      const object = await blobs.get(
        objectKey(member.workspaceId, source.path)
      );
      if (!object) {
        throw notFound();
      }
      const stored = await blobs.put(
        objectKey(member.workspaceId, path),
        object.bytes
      );
      if (!stored) {
        throw new ServiceError("conflict", "The file changed during the move");
      }
      copied.push(
        rowOf(member, path, {
          etag: stored.etag,
          kind: "file",
          size: object.bytes.byteLength,
        })
      );
    }
    return copied;
  };

  const prepareMoveVersions = async (
    member: Member,
    moved: EntryRow[],
    from: string,
    to: string
  ) => {
    const versionStatements: Statement[] = [];
    const moveVersions: VersionRow[] = [];
    for (const entry of moved.filter((item) => item.kind === "file")) {
      const path = `${to}${entry.path.slice(from.length)}`;
      // biome-ignore lint/performance/noAwaitInLoops: snapshot one file at a time
      const seeds = await history.seed(entry);
      const previous = await history.list(member.workspaceId, entry.path);
      const destination = await entryAt(member.workspaceId, path);
      const targetSeeds = await history.seed(destination);
      const targetHistory = await history.list(member.workspaceId, path);
      const offset = targetHistory[0]?.version ?? targetSeeds[0]?.version ?? 0;
      // Overwrite moves retain both histories: destination first, then source, then move.
      versionStatements.push(...targetSeeds.map(history.insert));
      versionStatements.push(
        db
          .update(libraryVersions)
          .set({ path, version: sql`${libraryVersions.version} + ${offset}` })
          .where(
            and(
              eq(libraryVersions.workspaceId, member.workspaceId),
              eq(libraryVersions.path, entry.path)
            )
          )
      );
      versionStatements.push(
        ...seeds.map((seed) =>
          history.insert({ ...seed, path, version: seed.version + offset })
        )
      );
      const object = await blobs.get(objectKey(member.workspaceId, entry.path));
      if (!object) {
        throw notFound();
      }
      const version = await versionOf(
        member,
        { ...entry, mtime: clock.now().toISOString(), path },
        offset + (previous[0]?.version ?? seeds[0]?.version ?? 0) + 1,
        "move",
        object.bytes
      );
      moveVersions.push(version);
    }
    return { moveVersions, versionStatements };
  };

  const move = async (
    principal: Principal,
    rawFrom: string,
    rawTo: string
  ): Promise<LibraryEntry> => {
    const member = await resolveMember(
      requireWriter(principal, "library.move")
    );
    authorize(member, "library.move", {
      kind: LIBRARY_KIND,
      workspaceId: member.workspaceId,
    });
    const from = normalizePath(rawFrom);
    const to = normalizePath(rawTo);
    checkMovePaths(member, from, to);
    const source = await entryAt(member.workspaceId, from);
    if (!source) {
      throw notFound();
    }
    const target = await entryAt(member.workspaceId, to);
    if (target && !(source.kind === "file" && target.kind === "file")) {
      throw new ServiceError("conflict", "The destination exists");
    }
    const folders = await missingFolders(member.workspaceId, to);
    const below =
      source.kind === "dir" ? await subtree(member.workspaceId, from) : [];
    const moved = [source, ...below];
    const { versionStatements, moveVersions } = await prepareMoveVersions(
      member,
      moved,
      from,
      to
    );
    const copies = await copyRows(member, moved, from, to);
    const copiesByPath = new Map(copies.map((row) => [row.path, row]));
    for (const version of moveVersions) {
      const copy = copiesByPath.get(version.path);
      if (!copy) {
        throw notFound();
      }
      versionStatements.push(
        history.insert({
          ...version,
          createdAt: copy.mtime,
          etag: copy.etag ?? "",
        })
      );
    }
    const size = moved.reduce((total, entry) => total + entry.size, 0);
    await atomic([
      ...versionStatements,
      db
        .delete(libraryEntries)
        .where(
          or(
            and(
              eq(libraryEntries.workspaceId, member.workspaceId),
              inArray(libraryEntries.path, target ? [from, to] : [from])
            ),
            underFolder(member.workspaceId, from)
          )
        ),
      ...folderStatements(member, folders),
      ...chunks(copies, ROWS_PER_INSERT).map((rows) =>
        db.insert(libraryEntries).values(rows)
      ),
      eventStatement(member, "library.delete", from, size),
      eventStatement(member, "library.write", to, size),
    ]);
    await changed(member, [from, to]);
    await blobs.delete(
      moved
        .filter((entry) => entry.kind === "file")
        .map((entry) => objectKey(member.workspaceId, entry.path))
    );
    const [head] = copies;
    if (!head) {
      throw notFound();
    }
    return toEntry(head);
  };

  /**
   * The conflict copies (`<path>.conflict-<runId>`) at or below any root, as
   * sorted library paths. The root is the empty string and means the whole
   * library. The SQL LIKE is only a cheap pre-filter, so the name is checked
   * again here: a folder named like a copy, or a file below one, is not one.
   */
  const pendingConflicts = async (
    principal: Principal,
    roots: readonly string[]
  ): Promise<string[]> => {
    const member = await resolveMember(
      requireMember(principal, "library.list")
    );
    authorize(member, "library.list", {
      kind: LIBRARY_KIND,
      workspaceId: member.workspaceId,
    });
    const paths = roots.map((root) => normalizePath(root));
    if (paths.length === 0) {
      return [];
    }
    const inRoots = paths.includes(ROOT)
      ? undefined
      : or(
          ...paths.map((root) =>
            or(
              eq(libraryEntries.path, root),
              underFolder(member.workspaceId, root)
            )
          )
        );
    const rows = await db
      .select({ path: libraryEntries.path })
      .from(libraryEntries)
      .where(
        and(
          eq(libraryEntries.workspaceId, member.workspaceId),
          eq(libraryEntries.kind, "file"),
          like(libraryEntries.path, "%.conflict-%"),
          inRoots
        )
      )
      .orderBy(asc(libraryEntries.path));
    const access = await resolveMember(member);
    return rows
      .map((row) => row.path)
      .filter((path) => canReadAt(access, path) && isConflictPath(path));
  };

  /**
   * Logs one `bash` tool call: the script (the event log strips secrets from
   * it), how it ended and what it cost. Any member may log, because a script
   * that only reads is still a command. The writes inside the script log their
   * own events.
   */
  const recordCommand = async (
    principal: Principal,
    command: {
      exitCode: number;
      script: string;
      storageCalls: number;
      wallMs: number;
    }
  ): Promise<void> => {
    const member = requireMember(principal, "library.command");
    authorize(member, "library.command", {
      kind: LIBRARY_KIND,
      workspaceId: member.workspaceId,
    });
    await atomic([
      events.insertStatement({
        actor: actorOf(member),
        agentId: member.kind === "run" ? member.agentId : undefined,
        payload: command,
        runId: member.kind === "run" ? member.runId : undefined,
        type: "library.command",
        workspaceId: member.workspaceId,
      }),
    ]);
  };

  /**
   * Logs one `run_script` call: the library path of the script or "inline",
   * how it ended, how long it took and how big its output was. The event
   * never holds the code, args, stdin or output text. The payload is built
   * field by field, so nothing else on the argument reaches the log.
   */
  const recordScript = async (
    principal: Principal,
    script: {
      durationMs: number;
      exitCode: number;
      script: string;
      stderrBytes: number;
      stdoutBytes: number;
    }
  ): Promise<void> => {
    const member = requireMember(principal, "script.run");
    authorize(member, "script.run", {
      kind: LIBRARY_KIND,
      workspaceId: member.workspaceId,
    });
    await atomic([
      events.insertStatement({
        actor: actorOf(member),
        agentId: member.kind === "run" ? member.agentId : undefined,
        payload: {
          durationMs: script.durationMs,
          exitCode: script.exitCode,
          script: script.script,
          stderrBytes: script.stderrBytes,
          stdoutBytes: script.stdoutBytes,
          text: `Ran ${script.script}, exit code ${script.exitCode}, ${script.durationMs} ms`,
        },
        runId: member.kind === "run" ? member.runId : undefined,
        type: "script.run",
        workspaceId: member.workspaceId,
      }),
    ]);
  };

  /**
   * Logs a write that hit a conflict and where its copy went. Paths are
   * normalised first, so the event never holds a leading slash.
   */
  const recordConflict = async (
    principal: Principal,
    conflict: { conflictPath: string; path: string }
  ): Promise<void> => {
    const member = requireMember(principal, "library.conflict");
    authorize(member, "library.conflict", {
      kind: LIBRARY_KIND,
      workspaceId: member.workspaceId,
    });
    await atomic([
      events.insertStatement({
        actor: actorOf(member),
        agentId: member.kind === "run" ? member.agentId : undefined,
        payload: {
          conflictPath: normalizePath(conflict.conflictPath),
          path: normalizePath(conflict.path),
          ...(member.kind === "run" ? { runId: member.runId } : {}),
        },
        runId: member.kind === "run" ? member.runId : undefined,
        type: "library.conflict",
        workspaceId: member.workspaceId,
      }),
    ]);
  };

  return {
    compare,
    list,
    mkdir,
    move,
    pendingConflicts,
    pruneVersions: history.prune,
    read,
    readVersion,
    recordCommand,
    recordConflict,
    recordScript,
    remove,
    restore,
    stat,
    versions,
    write,
  };
};

export type LibraryService = ReturnType<typeof createLibraryService>;
