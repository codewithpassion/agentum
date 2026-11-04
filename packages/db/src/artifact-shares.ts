// Query functions for artifact links and the access log (A.3). They take a
// drizzle instance and never make one. The writes that must land together
// return an unexecuted statement for `atomic`.
import { and, desc, eq, gte, isNull, lt, ne, type SQL, sql } from "drizzle-orm";
import type { Statement } from "./atomic.ts";
import type { Database } from "./database.ts";
import { agents } from "./schema/agents.ts";
import {
  artifactShares,
  artifacts,
  artifactVersions,
  artifactViewSalts,
  artifactViews,
} from "./schema/artifacts.ts";
import { workspaces } from "./schema/workspaces.ts";

export type ArtifactShareRow = typeof artifactShares.$inferSelect;
export type NewArtifactShare = typeof artifactShares.$inferInsert;
export type NewArtifactView = typeof artifactViews.$inferInsert;

/** The columns of an artifact that the share rules read. */
export interface ArtifactAccessRow {
  agentId: string | null;
  audience: "private" | "workspace";
  currentVersionId: string | null;
  handedToAgentId: string | null;
  id: string;
  kind: import("./shared.ts").ArtifactKind;
  ownerUserId: string | null;
  title: string;
  workspaceId: string;
}

export interface ArtifactVersionRef {
  createdAt: string;
  id: string;
  number: number;
  status: "published" | "proposed" | "rejected";
}

const accessColumns = {
  agentId: artifacts.agentId,
  audience: artifacts.audience,
  currentVersionId: artifacts.currentVersionId,
  handedToAgentId: artifacts.handedToAgentId,
  id: artifacts.id,
  kind: artifacts.kind,
  ownerUserId: artifacts.ownerUserId,
  title: artifacts.title,
  workspaceId: artifacts.workspaceId,
};

const versionColumns = {
  createdAt: artifactVersions.createdAt,
  id: artifactVersions.id,
  number: artifactVersions.number,
  status: artifactVersions.status,
};

/** A live (not deleted) artifact of the workspace, or undefined. */
export const getLiveArtifact = async (
  db: Database,
  workspaceId: string,
  artifactId: string
): Promise<ArtifactAccessRow | undefined> => {
  const [row] = await db
    .select(accessColumns)
    .from(artifacts)
    .where(
      and(
        eq(artifacts.id, artifactId),
        eq(artifacts.workspaceId, workspaceId),
        isNull(artifacts.deletedAt)
      )
    )
    .limit(1);
  return row;
};

export const getVersionByNumber = async (
  db: Database,
  artifactId: string,
  number: number
): Promise<ArtifactVersionRef | undefined> => {
  const [row] = await db
    .select(versionColumns)
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.artifactId, artifactId),
        eq(artifactVersions.number, number)
      )
    )
    .limit(1);
  return row;
};

export const getVersionById = async (
  db: Database,
  artifactId: string,
  versionId: string
): Promise<ArtifactVersionRef | undefined> => {
  const [row] = await db
    .select(versionColumns)
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.artifactId, artifactId),
        eq(artifactVersions.id, versionId)
      )
    )
    .limit(1);
  return row;
};

export const insertShareStatement = (
  db: Database,
  row: NewArtifactShare
): Statement => db.insert(artifactShares).values(row);

/** The links of one artifact, newest first. */
export const listShares = (
  db: Database,
  workspaceId: string,
  artifactId: string
): Promise<ArtifactShareRow[]> =>
  Promise.resolve(
    db
      .select()
      .from(artifactShares)
      .where(
        and(
          eq(artifactShares.workspaceId, workspaceId),
          eq(artifactShares.artifactId, artifactId)
        )
      )
      .orderBy(desc(artifactShares.createdAt), desc(artifactShares.id))
  );

export const getShareById = async (
  db: Database,
  workspaceId: string,
  shareId: string
): Promise<ArtifactShareRow | undefined> => {
  const [row] = await db
    .select()
    .from(artifactShares)
    .where(
      and(
        eq(artifactShares.id, shareId),
        eq(artifactShares.workspaceId, workspaceId)
      )
    )
    .limit(1);
  return row;
};

/** A link joined with what an open needs to decide and to answer. */
export interface ShareLookup {
  agentId: string | null;
  agentName: string | null;
  artifactDeletedAt: string | null;
  artifactId: string;
  clerkOrgId: string;
  currentVersionId: string | null;
  dataMode: "snapshot" | "live";
  expiresAt: string | null;
  grantedBy: string | null;
  kind: import("./shared.ts").ArtifactKind;
  linksEnabled: boolean;
  /** JSON array of tool keys, or null. */
  liveTools: string | null;
  ownerUserId: string | null;
  revokedAt: string | null;
  shareId: string;
  title: string;
  versionId: string | null;
  workspaceId: string;
  workspaceName: string;
}

const shareLookupQuery = (db: Database) =>
  db
    .select({
      agentId: artifacts.agentId,
      agentName: agents.name,
      artifactDeletedAt: artifacts.deletedAt,
      artifactId: artifacts.id,
      clerkOrgId: workspaces.clerkOrgId,
      currentVersionId: artifacts.currentVersionId,
      dataMode: artifactShares.dataMode,
      expiresAt: artifactShares.expiresAt,
      grantedBy: artifactShares.grantedBy,
      kind: artifacts.kind,
      linksEnabled: workspaces.artifactLinksEnabled,
      liveTools: artifactShares.liveTools,
      ownerUserId: artifacts.ownerUserId,
      revokedAt: artifactShares.revokedAt,
      shareId: artifactShares.id,
      title: artifacts.title,
      versionId: artifactShares.versionId,
      workspaceId: artifactShares.workspaceId,
      workspaceName: workspaces.name,
    })
    .from(artifactShares)
    .innerJoin(artifacts, eq(artifacts.id, artifactShares.artifactId))
    .innerJoin(workspaces, eq(workspaces.id, artifactShares.workspaceId))
    .leftJoin(agents, eq(agents.id, artifacts.agentId));

/** The link whose token hashes to `tokenHash`, across workspaces. */
export const getShareByHash = async (
  db: Database,
  tokenHash: string
): Promise<ShareLookup | undefined> => {
  const [row] = await shareLookupQuery(db)
    .where(eq(artifactShares.tokenHash, tokenHash))
    .limit(1);
  return row;
};

/** The link with this id on this artifact, across workspaces. */
export const getShareLookupById = async (
  db: Database,
  shareId: string,
  artifactId: string
): Promise<ShareLookup | undefined> => {
  const [row] = await shareLookupQuery(db)
    .where(
      and(
        eq(artifactShares.id, shareId),
        eq(artifactShares.artifactId, artifactId)
      )
    )
    .limit(1);
  return row;
};

/** Revokes a link that is still active. Matches nothing when it was revoked already. */
export const revokeShareStatement = (
  db: Database,
  shareId: string,
  revokedAt: string,
  revokedBy: string
): Statement =>
  db
    .update(artifactShares)
    .set({ revokedAt, revokedBy })
    .where(
      and(eq(artifactShares.id, shareId), isNull(artifactShares.revokedAt))
    );

export const bumpShareOpenStatement = (
  db: Database,
  shareId: string,
  openedAt: string
): Statement =>
  db
    .update(artifactShares)
    .set({
      lastOpenedAt: openedAt,
      openCount: sql`${artifactShares.openCount} + 1`,
    })
    .where(eq(artifactShares.id, shareId));

export const insertViewStatement = (
  db: Database,
  row: NewArtifactView
): Statement => db.insert(artifactViews).values(row);

export type ArtifactViewRow = Omit<
  typeof artifactViews.$inferSelect,
  "durationMs" | "guestId" | "statusCode" | "visitorHash" | "workspaceId"
>;

/**
 * One page of the access log of an artifact, newest first, optionally of one
 * link. `before` is exclusive: pass the id of the last row of the page before.
 * The visitor hash stays out.
 */
export const listViews = (
  db: Database,
  input: {
    artifactId: string;
    before?: string;
    limit: number;
    shareId?: string;
    workspaceId: string;
  }
): Promise<ArtifactViewRow[]> =>
  Promise.resolve(
    db
      .select({
        artifactId: artifactViews.artifactId,
        asn: artifactViews.asn,
        asOrg: artifactViews.asOrg,
        city: artifactViews.city,
        country: artifactViews.country,
        createdAt: artifactViews.createdAt,
        id: artifactViews.id,
        ipPrefix: artifactViews.ipPrefix,
        outcome: artifactViews.outcome,
        referrerHost: artifactViews.referrerHost,
        region: artifactViews.region,
        shareId: artifactViews.shareId,
        surface: artifactViews.surface,
        toolKey: artifactViews.toolKey,
        userAgent: artifactViews.userAgent,
        userId: artifactViews.userId,
        versionId: artifactViews.versionId,
      })
      .from(artifactViews)
      .where(
        and(
          eq(artifactViews.workspaceId, input.workspaceId),
          eq(artifactViews.artifactId, input.artifactId),
          input.shareId ? eq(artifactViews.shareId, input.shareId) : undefined,
          input.before ? lt(artifactViews.id, input.before) : undefined
        )
      )
      .orderBy(desc(artifactViews.id))
      .limit(input.limit)
  );

/**
 * The salt for `day` in the workspace. The first caller of the day writes
 * `candidate`; two racing first calls keep one row, and both read it back.
 */
export const ensureViewSalt = async (
  db: Database,
  workspaceId: string,
  day: string,
  candidate: string
): Promise<string> => {
  await db
    .insert(artifactViewSalts)
    .values({ day, salt: candidate, workspaceId })
    .onConflictDoNothing();
  const [row] = await db
    .select({ salt: artifactViewSalts.salt })
    .from(artifactViewSalts)
    .where(
      and(
        eq(artifactViewSalts.workspaceId, workspaceId),
        eq(artifactViewSalts.day, day)
      )
    )
    .limit(1);
  if (!row) {
    throw new Error("The view salt is missing after insert.");
  }
  return row.salt;
};

/** Deletes access-log rows created before `cutoff` (ISO), in every workspace. */
export const pruneViews = async (
  db: Database,
  cutoff: string
): Promise<void> => {
  await db.delete(artifactViews).where(lt(artifactViews.createdAt, cutoff));
};

/** Deletes salts of days before `cutoffDay` (`YYYY-MM-DD`), in every workspace. */
export const pruneViewSalts = async (
  db: Database,
  cutoffDay: string
): Promise<void> => {
  await db
    .delete(artifactViewSalts)
    .where(lt(artifactViewSalts.day, cutoffDay));
};

export const getLinkSwitch = async (
  db: Database,
  workspaceId: string
): Promise<boolean> => {
  const [row] = await db
    .select({ enabled: workspaces.artifactLinksEnabled })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row?.enabled ?? false;
};

export const setLinkSwitchStatement = (
  db: Database,
  workspaceId: string,
  enabled: boolean
): Statement =>
  db
    .update(workspaces)
    .set({ artifactLinksEnabled: enabled })
    .where(eq(workspaces.id, workspaceId));

/**
 * How many live calls a link took since `since` (ISO), for the rate limits.
 * Rows that were themselves rate limited do not count, so a window recovers on
 * its own. `visitorHash` narrows the count to one visitor; null counts the
 * visitors the Worker could not hash (no IP).
 */
export const countLiveCalls = async (
  db: Database,
  query: {
    shareId: string;
    since: string;
    visitorHash?: string | null;
  }
): Promise<number> => {
  let visitor: SQL | undefined;
  if (query.visitorHash === null) {
    visitor = isNull(artifactViews.visitorHash);
  } else if (query.visitorHash !== undefined) {
    visitor = eq(artifactViews.visitorHash, query.visitorHash);
  }
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(artifactViews)
    .where(
      and(
        eq(artifactViews.shareId, query.shareId),
        eq(artifactViews.surface, "live_call"),
        ne(artifactViews.outcome, "rate_limited"),
        gte(artifactViews.createdAt, query.since),
        visitor
      )
    );
  return Number(row?.total ?? 0);
};

/** Sets the outcome of a view row written before its call ran. */
export const setViewOutcomeStatement = (
  db: Database,
  viewId: string,
  outcome: NewArtifactView["outcome"]
): Statement =>
  db.update(artifactViews).set({ outcome }).where(eq(artifactViews.id, viewId));
