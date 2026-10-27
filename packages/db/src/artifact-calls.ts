// Query functions for a member's live tool calls and app storage (phase 2,
// task B.5). They take a drizzle instance and never make one.
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "./database.ts";
import {
  artifactGrants,
  artifacts,
  artifactVersions,
} from "./schema/artifacts.ts";
import { connectors } from "./schema/connectors.ts";
import type { ArtifactAudience, ArtifactVersionStatus } from "./shared.ts";

export interface ArtifactAccessRow {
  agentId: string | null;
  audience: ArtifactAudience;
  handedToAgentId: string | null;
  ownerUserId: string | null;
}

/** What the open check needs of an artifact that is not soft-deleted, or null. */
export const findArtifactAccess = async (
  db: Database,
  query: { artifactId: string; workspaceId: string }
): Promise<ArtifactAccessRow | null> => {
  const [row] = await db
    .select({
      agentId: artifacts.agentId,
      audience: artifacts.audience,
      handedToAgentId: artifacts.handedToAgentId,
      ownerUserId: artifacts.ownerUserId,
    })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.id, query.artifactId),
        eq(artifacts.workspaceId, query.workspaceId),
        isNull(artifacts.deletedAt)
      )
    )
    .limit(1);
  return row ?? null;
};

/** The status of a version of the artifact, or null when it is not one of its versions. */
export const findVersionStatus = async (
  db: Database,
  query: { artifactId: string; versionId: string; workspaceId: string }
): Promise<ArtifactVersionStatus | null> => {
  const [row] = await db
    .select({ status: artifactVersions.status })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.id, query.versionId),
        eq(artifactVersions.artifactId, query.artifactId),
        eq(artifactVersions.workspaceId, query.workspaceId)
      )
    )
    .limit(1);
  return row?.status ?? null;
};

/** The `<serverKey>/<tool>` targets a person approved for a version. */
export const approvedToolTargets = async (
  db: Database,
  query: { versionId: string; workspaceId: string }
): Promise<string[]> => {
  const rows = await db
    .select({ target: artifactGrants.target })
    .from(artifactGrants)
    .where(
      and(
        eq(artifactGrants.versionId, query.versionId),
        eq(artifactGrants.workspaceId, query.workspaceId),
        eq(artifactGrants.kind, "tool"),
        eq(artifactGrants.status, "approved")
      )
    );
  return rows.map((row) => row.target);
};

export interface ConnectorCallRow {
  callTimeoutSeconds: number;
  headerName: string | null;
  id: string;
  name: string;
  /** JSON array of `{ name, description, readOnly }`. */
  tools: string;
  url: string;
}

/**
 * Every connector of the workspace in creation order. The order gives the
 * server keys, so the same list always maps `<serverKey>/<tool>` to the same
 * connector.
 */
export const workspaceConnectors = async (
  db: Database,
  workspaceId: string
): Promise<ConnectorCallRow[]> =>
  await db
    .select({
      callTimeoutSeconds: connectors.callTimeoutSeconds,
      headerName: connectors.headerName,
      id: connectors.id,
      name: connectors.name,
      tools: connectors.tools,
      url: connectors.url,
    })
    .from(connectors)
    .where(eq(connectors.workspaceId, workspaceId))
    .orderBy(asc(connectors.createdAt), asc(connectors.id));
