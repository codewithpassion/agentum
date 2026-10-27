// Query functions for artifact grants, pins and hand-to (phase 2, task B.4).
// They take a drizzle instance and never make one. Writes that must land
// together come back as unexecuted statements for `atomic`.

import { and, asc, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import type { Database } from "./database.ts";
import {
  artifactGrants,
  artifactPins,
  artifacts,
  artifactVersions,
} from "./schema/artifacts.ts";
import { runRequests } from "./schema/requests.ts";
import type {
  ArtifactGrantKind,
  ArtifactGrantStatus,
  ArtifactPinSurface,
} from "./shared.ts";

export type ArtifactRow = typeof artifacts.$inferSelect;
export type ArtifactVersionRow = typeof artifactVersions.$inferSelect;
export type ArtifactGrantRow = typeof artifactGrants.$inferSelect;
export type ArtifactPinRow = typeof artifactPins.$inferSelect;
export type ArtifactGrantInsert = typeof artifactGrants.$inferInsert;

/** The tool name and tool use prefix of a promote request in Needs you. */
export const PROMOTE_TOOL_NAME = "artifact_promote";
export const PROMOTE_TOOL_USE_PREFIX = "artifact-promote:";

/** An artifact that is not soft-deleted, or null. */
export const findArtifact = async (
  db: Database,
  query: { id: string; workspaceId: string }
): Promise<ArtifactRow | null> => {
  const [row] = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.id, query.id),
        eq(artifacts.workspaceId, query.workspaceId),
        isNull(artifacts.deletedAt)
      )
    );
  return row ?? null;
};

export const findVersion = async (
  db: Database,
  query: { artifactId: string; id: string; workspaceId: string }
): Promise<ArtifactVersionRow | null> => {
  const [row] = await db
    .select()
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.id, query.id),
        eq(artifactVersions.artifactId, query.artifactId),
        eq(artifactVersions.workspaceId, query.workspaceId)
      )
    );
  return row ?? null;
};

/** A version by id alone, for callers that hold only a grant. */
export const findVersionById = async (
  db: Database,
  query: { id: string; workspaceId: string }
): Promise<ArtifactVersionRow | null> => {
  const [row] = await db
    .select()
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.id, query.id),
        eq(artifactVersions.workspaceId, query.workspaceId)
      )
    );
  return row ?? null;
};

export const findGrant = async (
  db: Database,
  query: { id: string; workspaceId: string }
): Promise<ArtifactGrantRow | null> => {
  const [row] = await db
    .select()
    .from(artifactGrants)
    .where(
      and(
        eq(artifactGrants.id, query.id),
        eq(artifactGrants.workspaceId, query.workspaceId)
      )
    );
  return row ?? null;
};

export const listGrants = (
  db: Database,
  query: { versionId: string; workspaceId: string }
): Promise<ArtifactGrantRow[]> =>
  db
    .select()
    .from(artifactGrants)
    .where(
      and(
        eq(artifactGrants.versionId, query.versionId),
        eq(artifactGrants.workspaceId, query.workspaceId)
      )
    )
    .orderBy(
      asc(artifactGrants.kind),
      asc(artifactGrants.target),
      asc(artifactGrants.id)
    );

/** The grants of a version a person approved (or that were carried over). */
export const approvedGrants = async (
  db: Database,
  query: { versionId: string; workspaceId: string }
): Promise<{ kind: ArtifactGrantKind; target: string }[]> => {
  const rows = await db
    .select({ kind: artifactGrants.kind, target: artifactGrants.target })
    .from(artifactGrants)
    .where(
      and(
        eq(artifactGrants.versionId, query.versionId),
        eq(artifactGrants.workspaceId, query.workspaceId),
        eq(artifactGrants.status, "approved")
      )
    );
  return rows;
};

export const insertGrants = (db: Database, rows: ArtifactGrantInsert[]) =>
  db.insert(artifactGrants).values(rows);

/**
 * Decides the grants that are still pending and returns the ids this call
 * decided. It is the arbiter between callers that race: only the one whose
 * update changed a row writes the event, so an event is written once.
 */
export const claimGrants = async (
  db: Database,
  query: {
    decidedAt: string;
    decidedBy: string;
    ids: string[];
    status: Exclude<ArtifactGrantStatus, "pending">;
  }
): Promise<string[]> => {
  if (query.ids.length === 0) {
    return [];
  }
  const rows = await db
    .update(artifactGrants)
    .set({
      decidedAt: query.decidedAt,
      decidedBy: query.decidedBy,
      status: query.status,
    })
    .where(
      and(
        inArray(artifactGrants.id, query.ids),
        eq(artifactGrants.status, "pending")
      )
    )
    .returning({ id: artifactGrants.id });
  return rows.map((row) => row.id);
};

/** A proposed version a person declined. */
export const rejectVersionStatement = (db: Database, versionId: string) =>
  db
    .update(artifactVersions)
    .set({ status: "rejected" })
    .where(
      and(
        eq(artifactVersions.id, versionId),
        eq(artifactVersions.status, "proposed")
      )
    );

/**
 * Publishes a proposed version and says whether this call did it, so of two
 * callers that race only one announces the promote.
 */
export const claimProposedVersion = async (
  db: Database,
  versionId: string
): Promise<boolean> => {
  const rows = await db
    .update(artifactVersions)
    .set({ status: "published" })
    .where(
      and(
        eq(artifactVersions.id, versionId),
        eq(artifactVersions.status, "proposed")
      )
    )
    .returning({ id: artifactVersions.id });
  return rows.length > 0;
};

/**
 * Points the artifact at a version, but only when that version is newer than
 * the current one, so two versions going live together cannot leave the older
 * one current.
 */
export const setCurrentVersionStatement = (
  db: Database,
  query: {
    artifactId: string;
    now: string;
    versionId: string;
    versionNumber: number;
  }
) =>
  db
    .update(artifacts)
    .set({ currentVersionId: query.versionId, updatedAt: query.now })
    .where(
      and(
        eq(artifacts.id, query.artifactId),
        sql`(${artifacts.currentVersionId} is null or (select ${artifactVersions.number} from ${artifactVersions} where ${artifactVersions.id} = ${artifacts.currentVersionId}) < ${query.versionNumber})`
      )
    );

export const setHandedToStatement = (
  db: Database,
  query: { agentId: string | null; artifactId: string; now: string }
) =>
  db
    .update(artifacts)
    .set({ handedToAgentId: query.agentId, updatedAt: query.now })
    .where(eq(artifacts.id, query.artifactId));

/** Promote requests for a version, newest first. They may belong to different runs. */
export const promoteRequests = (
  db: Database,
  query: { versionId: string; workspaceId: string }
) =>
  db
    .select()
    .from(runRequests)
    .where(
      and(
        eq(runRequests.workspaceId, query.workspaceId),
        eq(runRequests.toolName, PROMOTE_TOOL_NAME),
        like(
          runRequests.toolUseId,
          `${PROMOTE_TOOL_USE_PREFIX}${query.versionId}:%`
        )
      )
    )
    .orderBy(desc(runRequests.createdAt), desc(runRequests.id));

/** The largest pin position the person has on a surface, 0 when none. */
export const maxPinPosition = async (
  db: Database,
  query: { surface: ArtifactPinSurface; userId: string; workspaceId: string }
): Promise<number> => {
  const [row] = await db
    .select({
      max: sql<number>`coalesce(max(${artifactPins.position}), 0)`,
    })
    .from(artifactPins)
    .where(
      and(
        eq(artifactPins.userId, query.userId),
        eq(artifactPins.workspaceId, query.workspaceId),
        eq(artifactPins.surface, query.surface)
      )
    );
  return row?.max ?? 0;
};

/** Pins an artifact. A second pin of the same artifact on the surface changes nothing. */
export const insertPin = (
  db: Database,
  row: typeof artifactPins.$inferInsert
) =>
  db
    .insert(artifactPins)
    .values(row)
    .onConflictDoNothing({
      target: [
        artifactPins.userId,
        artifactPins.artifactId,
        artifactPins.surface,
      ],
    });

export const deletePin = (
  db: Database,
  query: {
    artifactId: string;
    surface: ArtifactPinSurface;
    userId: string;
    workspaceId: string;
  }
) =>
  db
    .delete(artifactPins)
    .where(
      and(
        eq(artifactPins.userId, query.userId),
        eq(artifactPins.artifactId, query.artifactId),
        eq(artifactPins.surface, query.surface),
        eq(artifactPins.workspaceId, query.workspaceId)
      )
    );

export interface PinnedArtifact {
  agentId: string | null;
  artifactId: string;
  audience: ArtifactRow["audience"];
  createdAt: string;
  handedToAgentId: string | null;
  kind: ArtifactRow["kind"];
  ownerUserId: string | null;
  position: number;
  surface: ArtifactPinSurface;
  thumbnailKey: string | null;
  title: string;
}

/** A person's pins with the artifact fields a tile needs. Deleted artifacts are left out. */
export const listPins = (
  db: Database,
  query: {
    surface?: ArtifactPinSurface;
    userId: string;
    workspaceId: string;
  }
): Promise<PinnedArtifact[]> =>
  db
    .select({
      agentId: artifacts.agentId,
      artifactId: artifacts.id,
      audience: artifacts.audience,
      createdAt: artifactPins.createdAt,
      handedToAgentId: artifacts.handedToAgentId,
      kind: artifacts.kind,
      ownerUserId: artifacts.ownerUserId,
      position: artifactPins.position,
      surface: artifactPins.surface,
      thumbnailKey: artifacts.thumbnailKey,
      title: artifacts.title,
    })
    .from(artifactPins)
    .innerJoin(artifacts, eq(artifacts.id, artifactPins.artifactId))
    .where(
      and(
        eq(artifactPins.userId, query.userId),
        eq(artifactPins.workspaceId, query.workspaceId),
        isNull(artifacts.deletedAt),
        query.surface === undefined
          ? undefined
          : eq(artifactPins.surface, query.surface)
      )
    )
    .orderBy(
      asc(artifactPins.surface),
      asc(artifactPins.position),
      asc(artifactPins.id)
    );
