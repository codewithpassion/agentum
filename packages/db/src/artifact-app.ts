// Query functions for the grants an app artifact's server code runs under
// (phase 2, task B.8). They take a drizzle instance and never make one.

import { and, asc, eq } from "drizzle-orm";
import type { Database } from "./database.ts";
import { artifactGrants, artifactVersions } from "./schema/artifacts.ts";
import { workspaces } from "./schema/workspaces.ts";
import type { ArtifactGrantKind } from "./shared.ts";

/** The targets of the version's approved grants of one kind, sorted. */
export const approvedGrantTargets = async (
  db: Database,
  query: { kind: ArtifactGrantKind; versionId: string }
): Promise<string[]> => {
  const rows = await db
    .select({ target: artifactGrants.target })
    .from(artifactGrants)
    .where(
      and(
        eq(artifactGrants.versionId, query.versionId),
        eq(artifactGrants.kind, query.kind),
        eq(artifactGrants.status, "approved")
      )
    )
    .orderBy(asc(artifactGrants.target));
  return rows.map((row) => row.target);
};

/** Whether the version has a grant of this kind in any status. */
export const hasGrantOfKind = async (
  db: Database,
  query: { kind: ArtifactGrantKind; versionId: string }
): Promise<boolean> => {
  const [row] = await db
    .select({ id: artifactGrants.id })
    .from(artifactGrants)
    .where(
      and(
        eq(artifactGrants.versionId, query.versionId),
        eq(artifactGrants.kind, query.kind)
      )
    )
    .limit(1);
  return row !== undefined;
};

/** The workspace of a version, when the version belongs to the artifact. */
export const versionWorkspaceId = async (
  db: Database,
  query: { artifactId: string; versionId: string }
): Promise<string | null> => {
  const [row] = await db
    .select({ workspaceId: artifactVersions.workspaceId })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.id, query.versionId),
        eq(artifactVersions.artifactId, query.artifactId)
      )
    )
    .limit(1);
  return row?.workspaceId ?? null;
};

/** The Clerk organisation of a workspace, or null when there is no such workspace. */
export const workspaceClerkOrgId = async (
  db: Database,
  workspaceId: string
): Promise<string | null> => {
  const [row] = await db
    .select({ clerkOrgId: workspaces.clerkOrgId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row?.clerkOrgId ?? null;
};
