// biome-ignore-all lint/performance/noAwaitInLoops: bound blob memory and complete each prune batch before the next
import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import { type libraryEntries, libraryVersions } from "@repo/db/schema/library";
import {
  LIBRARY_VERSION_KEEP_DAYS,
  LIBRARY_VERSION_KEEP_MIN,
} from "@repo/db/shared";
import { and, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { ServiceError } from "../errors.ts";
import type { LibraryBlobs } from "../library.ts";

/** Rows per delete, under D1's bound-parameter limit. */
const PRUNE_BATCH = 90;
/** Expired-delete files read per query. */
const PRUNE_PAGE = 50;

export type VersionRow = typeof libraryVersions.$inferSelect;
type EntryRow = typeof libraryEntries.$inferSelect;

export const createVersionStore = ({
  db,
  blobs,
  atomic,
}: {
  db: Database;
  blobs: LibraryBlobs;
  atomic: Atomic;
}) => {
  const list = (workspaceId: string, path: string): Promise<VersionRow[]> =>
    db
      .select()
      .from(libraryVersions)
      .where(
        and(
          eq(libraryVersions.workspaceId, workspaceId),
          eq(libraryVersions.path, path)
        )
      )
      .orderBy(desc(libraryVersions.version));

  const get = async (workspaceId: string, id: string): Promise<VersionRow> => {
    const [row] = await db
      .select()
      .from(libraryVersions)
      .where(
        and(
          eq(libraryVersions.workspaceId, workspaceId),
          eq(libraryVersions.id, id)
        )
      )
      .limit(1);
    if (!row) {
      throw new ServiceError("not_found", "Not found");
    }
    return row;
  };

  const read = async (workspaceId: string, id: string) => {
    const version = await get(workspaceId, id);
    if (!version.blobKey) {
      throw new ServiceError("invalid", "A delete tombstone has no bytes");
    }
    const object = await blobs.get(version.blobKey);
    if (!object) {
      throw new ServiceError("not_found", "Not found");
    }
    return { bytes: object.bytes, version };
  };

  const row = async (
    fields: Omit<VersionRow, "id" | "blobKey" | "sha256">,
    bytes: Uint8Array | null
  ): Promise<VersionRow> => {
    const id = ulid();
    const blobKey =
      bytes === null ? null : `${fields.workspaceId}/library-versions/${id}`;
    const sha256 =
      bytes === null
        ? ""
        : Array.from(
            new Uint8Array(
              await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
            ),
            (byte) => byte.toString(16).padStart(2, "0")
          ).join("");
    if (blobKey && bytes) {
      const stored = await blobs.put(blobKey, bytes);
      if (!stored) {
        throw new ServiceError("conflict", "Could not store version bytes");
      }
    }
    return { ...fields, blobKey, id, sha256 };
  };

  const insert = (version: VersionRow): Statement =>
    db.insert(libraryVersions).values(version);

  /**
   * Numbers the version inside the batch, so two writes to one path that race
   * between our read and the commit never collide on the unique index.
   */
  const insertNext = (version: VersionRow): Statement =>
    db.insert(libraryVersions).values({
      ...version,
      version: sql`(select coalesce(max(${libraryVersions.version}), 0) + 1 from ${libraryVersions} where ${libraryVersions.workspaceId} = ${version.workspaceId} and ${libraryVersions.path} = ${version.path})`,
    });

  /** A concurrent writer may seed the same file first; its seed wins. */
  const insertSeed = (version: VersionRow): Statement =>
    db.insert(libraryVersions).values(version).onConflictDoNothing();

  /** V4.1 intentionally left old files unversioned; capture them only on mutation. */
  const seed = async (entry: EntryRow | null): Promise<VersionRow[]> => {
    if (
      entry?.kind !== "file" ||
      (await list(entry.workspaceId, entry.path)).length > 0
    ) {
      return [];
    }
    const object = await blobs.get(
      `${entry.workspaceId}/library/${entry.path}`
    );
    if (!object) {
      throw new ServiceError("not_found", "Not found");
    }
    return [
      await row(
        {
          authorId: entry.updatedById,
          authorKind: entry.updatedByKind,
          createdAt: entry.mtime,
          etag: object.etag,
          op: "write",
          path: entry.path,
          runId: null,
          size: object.bytes.byteLength,
          version: 1,
          workspaceId: entry.workspaceId,
        },
        object.bytes
      ),
    ];
  };

  // Correlated subqueries over the (workspace, path, version) unique index.
  const inSameFile = sql`newer.workspace_id = ${libraryVersions.workspaceId} and newer.path = ${libraryVersions.path}`;

  const dropRows = async (
    batch: { blobKey: string | null; id: string }[]
  ): Promise<void> => {
    // Delete objects first: if storage fails, the rows remain for the next tick.
    await blobs.delete(
      batch.flatMap((version) => (version.blobKey ? [version.blobKey] : []))
    );
    await atomic([
      db.delete(libraryVersions).where(
        inArray(
          libraryVersions.id,
          batch.map((version) => version.id)
        )
      ),
    ]);
  };

  /**
   * Deletes a file's history up to its tombstone, oldest first so the
   * tombstone goes last and a failed prune can resume. A version written after
   * the tombstone (the file came back mid-prune) is not part of that history.
   */
  const dropHistory = async (
    workspaceId: string,
    path: string,
    tombstone: number
  ): Promise<void> => {
    for (;;) {
      const batch = await db
        .select({ blobKey: libraryVersions.blobKey, id: libraryVersions.id })
        .from(libraryVersions)
        .where(
          and(
            eq(libraryVersions.workspaceId, workspaceId),
            eq(libraryVersions.path, path),
            lte(libraryVersions.version, tombstone)
          )
        )
        .orderBy(libraryVersions.version)
        .limit(PRUNE_BATCH);
      if (batch.length === 0) {
        return;
      }
      await dropRows(batch);
    }
  };

  /** An expired delete ends the entire history, overriding the minimum count. */
  const pruneExpiredDeletes = async (cutoff: string): Promise<void> => {
    for (;;) {
      const files = await db
        .select({
          path: libraryVersions.path,
          version: libraryVersions.version,
          workspaceId: libraryVersions.workspaceId,
        })
        .from(libraryVersions)
        .where(
          and(
            eq(libraryVersions.op, "delete"),
            lt(libraryVersions.createdAt, cutoff),
            sql`${libraryVersions.version} = (select max(newer.version) from library_versions as newer where ${inSameFile})`
          )
        )
        .limit(PRUNE_PAGE);
      if (files.length === 0) {
        return;
      }
      for (const { path, version, workspaceId } of files) {
        await dropHistory(workspaceId, path, version);
      }
    }
  };

  /**
   * Past the newest KEEP_MIN of a file, a version expires with its age.
   * Ordered by `created_at` so SQLite walks the index. Only rows with at
   * least KEEP_MIN newer versions are deleted, so the newest KEEP_MIN are never touched.
   */
  const pruneExcessVersions = async (cutoff: string): Promise<void> => {
    for (;;) {
      const batch = await db
        .select({ blobKey: libraryVersions.blobKey, id: libraryVersions.id })
        .from(libraryVersions)
        .where(
          and(
            lt(libraryVersions.createdAt, cutoff),
            sql`(select count(*) from library_versions as newer where ${inSameFile} and newer.version > ${libraryVersions.version}) >= ${LIBRARY_VERSION_KEEP_MIN}`
          )
        )
        .orderBy(libraryVersions.createdAt, libraryVersions.version)
        .limit(PRUNE_BATCH);
      if (batch.length === 0) {
        return;
      }
      await dropRows(batch);
    }
  };

  /**
   * Finds candidates through the `created_at` index, so it reads rows older
   * than the cutoff, plus the files of expired tombstones. Each pass reads one
   * batch, deletes its blobs, then its rows, so a failed pass leaves the rows
   * for the next one.
   */
  const prune = async (now: Date): Promise<void> => {
    const cutoff = new Date(
      now.getTime() - LIBRARY_VERSION_KEEP_DAYS * 86_400_000
    ).toISOString();
    await pruneExpiredDeletes(cutoff);
    await pruneExcessVersions(cutoff);
  };
  return {
    get,
    insert,
    insertNext,
    insertSeed,
    list,
    prune,
    read,
    row,
    seed,
  };
};

/** Compare uses version IDs. NUL or invalid UTF-8 bytes make the whole comparison binary. */
export const compareVersionBytes = (
  a: Uint8Array,
  b: Uint8Array
): { kind: "binary" } | { kind: "text"; a: string; b: string } => {
  if (a.includes(0) || b.includes(0)) {
    return { kind: "binary" };
  }
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return { a: decoder.decode(a), b: decoder.decode(b), kind: "text" };
  } catch {
    return { kind: "binary" };
  }
};
