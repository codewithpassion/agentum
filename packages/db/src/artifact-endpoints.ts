import { and, desc, eq, isNull, notExists, sql } from "drizzle-orm";
import type { Database } from "./database.ts";
import {
  artifactEndpoints,
  artifactGrants,
  artifacts,
  artifactVersions,
  artifactViews,
} from "./schema/artifacts.ts";

export const endpointById = async (db: Database, id: string) =>
  (
    await db
      .select()
      .from(artifactEndpoints)
      .where(eq(artifactEndpoints.id, id))
  )[0] ?? null;
export const endpointsForArtifact = (db: Database, artifactId: string) =>
  db
    .select()
    .from(artifactEndpoints)
    .where(eq(artifactEndpoints.artifactId, artifactId))
    .orderBy(desc(artifactEndpoints.createdAt), desc(sql`rowid`));
export const insertEndpointStatement = (
  db: Database,
  row: typeof artifactEndpoints.$inferInsert
) => db.insert(artifactEndpoints).values(row);
/** Provision only the first address for a name, including disabled history. */
export const ensureEndpointStatement = (
  db: Database,
  row: {
    id: string;
    artifactId: string;
    workspaceId: string;
    name: string;
    createdAt: string;
  },
  grantId: string
) =>
  db
    .insert(artifactEndpoints)
    .select(
      db
        .select({
          artifactId: sql<string>`${row.artifactId}`.as("artifactId"),
          createdAt: sql<string>`${row.createdAt}`.as("createdAt"),
          disabledAt: sql<null>`null`.as("disabledAt"),
          id: sql<string>`${row.id}`.as("id"),
          name: sql<string>`${row.name}`.as("name"),
          workspaceId: sql<string>`${row.workspaceId}`.as("workspaceId"),
        })
        .from(artifactGrants)
        .where(
          and(
            eq(artifactGrants.id, grantId),
            eq(artifactGrants.status, "approved"),
            notExists(
              db
                .select({ id: artifactEndpoints.id })
                .from(artifactEndpoints)
                .where(
                  and(
                    eq(artifactEndpoints.artifactId, row.artifactId),
                    eq(artifactEndpoints.name, row.name)
                  )
                )
            )
          )
        )
    )
    .onConflictDoNothing();
export const setEndpointDisabledStatement = (
  db: Database,
  id: string,
  disabledAt: string | null
) =>
  db
    .update(artifactEndpoints)
    .set({ disabledAt })
    .where(eq(artifactEndpoints.id, id));
export const insertEndpointView = (
  db: Database,
  row: typeof artifactViews.$inferInsert
) => db.insert(artifactViews).values(row);

/** One fresh join: the public id only grants ingress to the live, approved version. */
export const resolveEndpoint = async (db: Database, id: string) => {
  const [row] = await db
    .select({
      artifactId: artifacts.id,
      endpointId: artifactEndpoints.id,
      name: artifactEndpoints.name,
      versionId: artifactVersions.id,
      workspaceId: artifacts.workspaceId,
    })
    .from(artifactEndpoints)
    .innerJoin(
      artifacts,
      and(
        eq(artifacts.id, artifactEndpoints.artifactId),
        eq(artifacts.workspaceId, artifactEndpoints.workspaceId)
      )
    )
    .innerJoin(
      artifactVersions,
      and(
        eq(artifactVersions.id, artifacts.currentVersionId),
        eq(artifactVersions.artifactId, artifacts.id),
        eq(artifactVersions.workspaceId, artifacts.workspaceId)
      )
    )
    .innerJoin(
      artifactGrants,
      and(
        eq(artifactGrants.versionId, artifactVersions.id),
        eq(artifactGrants.workspaceId, artifacts.workspaceId),
        eq(artifactGrants.kind, "endpoint"),
        eq(artifactGrants.target, artifactEndpoints.name),
        eq(artifactGrants.status, "approved")
      )
    )
    .where(
      and(
        eq(artifactEndpoints.id, id),
        isNull(artifactEndpoints.disabledAt),
        isNull(artifacts.deletedAt),
        eq(artifacts.kind, "app"),
        eq(artifactVersions.status, "published")
      )
    );
  return row ?? null;
};
