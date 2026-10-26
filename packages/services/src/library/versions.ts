// biome-ignore-all lint/performance/noAwaitInLoops: bound blob memory and complete each prune batch before the next
import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import { type libraryEntries, libraryVersions } from "@repo/db/schema/library";
import {
  LIBRARY_VERSION_KEEP_DAYS,
  LIBRARY_VERSION_KEEP_MIN,
} from "@repo/db/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { ulid } from "ulidx";
import { ServiceError } from "../errors.ts";
import type { LibraryBlobs } from "../library.ts";

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
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
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

  const prune = async (now: Date): Promise<void> => {
    const cutoff = new Date(
      now.getTime() - LIBRARY_VERSION_KEEP_DAYS * 86_400_000
    ).toISOString();
    const all = await db
      .select()
      .from(libraryVersions)
      .orderBy(desc(libraryVersions.version));
    const groups = new Map<string, VersionRow[]>();
    for (const version of all) {
      const key = JSON.stringify([version.workspaceId, version.path]);
      const group = groups.get(key) ?? [];
      group.push(version);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const [newest] = group;
      // An expired delete ends the entire history, overriding the minimum count.
      const expiredDelete =
        newest?.op === "delete" && newest.createdAt < cutoff;
      const expired = group.filter(
        (version, index) =>
          expiredDelete ||
          (index >= LIBRARY_VERSION_KEEP_MIN && version.createdAt < cutoff)
      );
      // Keep the tombstone until the final batch so a failed prune can resume.
      if (expiredDelete) {
        expired.reverse();
      }
      for (let offset = 0; offset < expired.length; offset += 90) {
        const batch = expired.slice(offset, offset + 90);
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
      }
    }
  };
  return { get, insert, list, prune, read, row, seed };
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
