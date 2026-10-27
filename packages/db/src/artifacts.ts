// Query functions for artifacts (A.2). Reads only: the service builds the writes
// as statements and commits them through `atomic`.

import {
  and,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database } from "./database.ts";
import {
  artifactPins,
  artifactShares,
  artifacts,
  artifactVersionFiles,
  artifactVersions,
} from "./schema/artifacts.ts";
import type { ArtifactKind } from "./shared.ts";

export type ArtifactRow = typeof artifacts.$inferSelect;
export type ArtifactVersionRow = typeof artifactVersions.$inferSelect;
export type ArtifactVersionFileRow = typeof artifactVersionFiles.$inferSelect;

/** D1 binds at most 100 parameters per statement. */
const IN_CHUNK = 80;

const chunked = <T>(items: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += IN_CHUNK) {
    out.push(items.slice(index, index + IN_CHUNK));
  }
  return out;
};

/** Runs `query` on each chunk of `items` at the same time and joins the rows. */
const queryChunks = async <T, R>(
  items: readonly T[],
  query: (part: T[]) => Promise<R[]>
): Promise<R[]> => (await Promise.all(chunked(items).map(query))).flat();

/** The artifact, or null when it is missing, in another workspace or soft-deleted. */
export const findArtifact = async (
  db: Database,
  workspaceId: string,
  artifactId: string
): Promise<ArtifactRow | null> => {
  const [row] = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.workspaceId, workspaceId),
        eq(artifacts.id, artifactId),
        isNull(artifacts.deletedAt)
      )
    )
    .limit(1);
  return row ?? null;
};

/** Who a list is for. A member sees workspace artifacts and their own, an admin all, a run its agent's. */
export type ArtifactVisibility =
  | { kind: "admin" }
  | { kind: "member"; userId: string }
  | { agentId: string; kind: "agent" };

const visibilityFilter = (visibility: ArtifactVisibility): SQL | undefined => {
  if (visibility.kind === "admin") {
    return;
  }
  if (visibility.kind === "member") {
    return or(
      eq(artifacts.audience, "workspace"),
      eq(artifacts.ownerUserId, visibility.userId)
    );
  }
  return or(
    eq(artifacts.audience, "workspace"),
    eq(artifacts.agentId, visibility.agentId),
    eq(artifacts.handedToAgentId, visibility.agentId)
  );
};

export interface ListArtifactsFilter {
  /** Keyset cursor from the previous page: `updatedAt` and `id` of its last row. */
  after?: { id: string; updatedAt: string };
  kind?: ArtifactKind;
  /** Rows to return. One more is read to know whether a next page exists. */
  limit: number;
  madeBy?: "agent" | "person";
  /** Now, ISO: a link expiring before it is no longer active. */
  now: string;
  /** Only artifacts with a version written by this run. */
  runId?: string;
  /** True: only artifacts with an active link. False: only those without. */
  shared?: boolean;
  visibility: ArtifactVisibility;
}

const activeShare = (now: string) =>
  and(
    eq(artifactShares.artifactId, artifacts.id),
    isNull(artifactShares.revokedAt),
    or(isNull(artifactShares.expiresAt), gt(artifactShares.expiresAt, now))
  );

/** Visible artifacts, newest update first. Returns up to `limit + 1` rows. */
export const listArtifacts = (
  db: Database,
  workspaceId: string,
  filter: ListArtifactsFilter
): Promise<ArtifactRow[]> => {
  const { after, shared } = filter;
  const sharedFilter = (() => {
    if (shared === undefined) {
      return;
    }
    const probe = exists(
      db
        .select({ one: sql`1` })
        .from(artifactShares)
        .where(activeShare(filter.now))
    );
    return shared ? probe : sql`not ${probe}`;
  })();
  return Promise.resolve(
    db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.workspaceId, workspaceId),
          isNull(artifacts.deletedAt),
          visibilityFilter(filter.visibility),
          filter.kind ? eq(artifacts.kind, filter.kind) : undefined,
          filter.madeBy === undefined
            ? undefined
            : eq(
                artifacts.createdByKind,
                filter.madeBy === "agent" ? "agent" : "user"
              ),
          sharedFilter,
          filter.runId
            ? exists(
                db
                  .select({ one: sql`1` })
                  .from(artifactVersions)
                  .where(
                    and(
                      eq(artifactVersions.artifactId, artifacts.id),
                      eq(artifactVersions.authorRunId, filter.runId)
                    )
                  )
              )
            : undefined,
          after
            ? or(
                lt(artifacts.updatedAt, after.updatedAt),
                and(
                  eq(artifacts.updatedAt, after.updatedAt),
                  lt(artifacts.id, after.id)
                )
              )
            : undefined
        )
      )
      .orderBy(desc(artifacts.updatedAt), desc(artifacts.id))
      .limit(filter.limit + 1)
  );
};

/** Active (not revoked, not expired) link counts by artifact id. */
export const activeLinkCounts = async (
  db: Database,
  workspaceId: string,
  artifactIds: readonly string[],
  now: string
): Promise<Map<string, number>> => {
  const rows = await queryChunks(artifactIds, async (ids) =>
    db
      .select({
        artifactId: artifactShares.artifactId,
        count: sql<number>`count(*)`,
      })
      .from(artifactShares)
      .where(
        and(
          eq(artifactShares.workspaceId, workspaceId),
          inArray(artifactShares.artifactId, ids),
          isNull(artifactShares.revokedAt),
          or(
            isNull(artifactShares.expiresAt),
            gt(artifactShares.expiresAt, now)
          )
        )
      )
      .groupBy(artifactShares.artifactId)
  );
  return new Map(rows.map((row) => [row.artifactId, Number(row.count)]));
};

/** The ids among `artifactIds` that `userId` pinned to any surface. */
export const pinnedArtifactIds = async (
  db: Database,
  workspaceId: string,
  userId: string,
  artifactIds: readonly string[]
): Promise<Set<string>> => {
  const rows = await queryChunks(artifactIds, async (ids) =>
    db
      .select({ artifactId: artifactPins.artifactId })
      .from(artifactPins)
      .where(
        and(
          eq(artifactPins.workspaceId, workspaceId),
          eq(artifactPins.userId, userId),
          inArray(artifactPins.artifactId, ids)
        )
      )
  );
  return new Set(rows.map((row) => row.artifactId));
};

/** Every version of the artifact, newest first. */
export const listVersions = (
  db: Database,
  workspaceId: string,
  artifactId: string
): Promise<ArtifactVersionRow[]> =>
  Promise.resolve(
    db
      .select()
      .from(artifactVersions)
      .where(
        and(
          eq(artifactVersions.workspaceId, workspaceId),
          eq(artifactVersions.artifactId, artifactId)
        )
      )
      .orderBy(desc(artifactVersions.number))
  );

export const findVersionByNumber = async (
  db: Database,
  workspaceId: string,
  artifactId: string,
  number: number
): Promise<ArtifactVersionRow | null> => {
  const [row] = await db
    .select()
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.workspaceId, workspaceId),
        eq(artifactVersions.artifactId, artifactId),
        eq(artifactVersions.number, number)
      )
    )
    .limit(1);
  return row ?? null;
};

export const findVersionById = async (
  db: Database,
  workspaceId: string,
  versionId: string
): Promise<ArtifactVersionRow | null> => {
  const [row] = await db
    .select()
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.workspaceId, workspaceId),
        eq(artifactVersions.id, versionId)
      )
    )
    .limit(1);
  return row ?? null;
};

/** The highest version number, 0 when the artifact has none. */
export const maxVersionNumber = async (
  db: Database,
  workspaceId: string,
  artifactId: string
): Promise<number> => {
  const [row] = await db
    .select({ max: sql<number | null>`max(${artifactVersions.number})` })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.workspaceId, workspaceId),
        eq(artifactVersions.artifactId, artifactId)
      )
    );
  return Number(row?.max ?? 0);
};

export const versionFiles = (
  db: Database,
  workspaceId: string,
  versionId: string
): Promise<ArtifactVersionFileRow[]> =>
  Promise.resolve(
    db
      .select()
      .from(artifactVersionFiles)
      .where(
        and(
          eq(artifactVersionFiles.workspaceId, workspaceId),
          eq(artifactVersionFiles.versionId, versionId)
        )
      )
      .orderBy(artifactVersionFiles.path)
  );

/** Size by hash for the hashes the workspace already stores. */
export const knownBlobSizes = async (
  db: Database,
  workspaceId: string,
  hashes: readonly string[]
): Promise<Map<string, number>> => {
  const rows = await queryChunks(hashes, async (part) =>
    db
      .selectDistinct({
        sha256: artifactVersionFiles.sha256,
        size: artifactVersionFiles.size,
      })
      .from(artifactVersionFiles)
      .where(
        and(
          eq(artifactVersionFiles.workspaceId, workspaceId),
          inArray(artifactVersionFiles.sha256, part)
        )
      )
  );
  return new Map(rows.map((row) => [row.sha256, row.size]));
};

/** Bytes of distinct blobs the workspace's artifact versions hold. */
export const workspaceBlobBytes = async (
  db: Database,
  workspaceId: string
): Promise<number> => {
  const distinct = db
    .selectDistinct({
      sha256: artifactVersionFiles.sha256,
      size: artifactVersionFiles.size,
    })
    .from(artifactVersionFiles)
    .where(eq(artifactVersionFiles.workspaceId, workspaceId))
    .as("blobs");
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${distinct.size}), 0)` })
    .from(distinct);
  return Number(row?.total ?? 0);
};

/** Versions by id, for the cards of a list. */
export const versionsByIds = async (
  db: Database,
  workspaceId: string,
  versionIds: readonly string[]
): Promise<Map<string, ArtifactVersionRow>> => {
  const rows = await queryChunks(versionIds, async (ids) =>
    db
      .select()
      .from(artifactVersions)
      .where(
        and(
          eq(artifactVersions.workspaceId, workspaceId),
          inArray(artifactVersions.id, ids)
        )
      )
  );
  return new Map(rows.map((row) => [row.id, row]));
};

/** The files of many versions at once, grouped by version id and sorted by path within a version. */
export const filesByVersionIds = async (
  db: Database,
  workspaceId: string,
  versionIds: readonly string[]
): Promise<Map<string, ArtifactVersionFileRow[]>> => {
  const rows = await queryChunks(versionIds, async (ids) =>
    db
      .select()
      .from(artifactVersionFiles)
      .where(
        and(
          eq(artifactVersionFiles.workspaceId, workspaceId),
          inArray(artifactVersionFiles.versionId, ids)
        )
      )
      .orderBy(artifactVersionFiles.path)
  );
  const grouped = new Map<string, ArtifactVersionFileRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.versionId);
    if (list) {
      list.push(row);
    } else {
      grouped.set(row.versionId, [row]);
    }
  }
  return grouped;
};
