import type { Database } from "@repo/db";
import { artifacts } from "@repo/db/schema/artifacts";
import { artifactMembers } from "@repo/db/schema/live-artifacts";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import type { Principal } from "../workspaces.ts";

/** Artifact sessions are shared only with people who can open this artifact. */
export const authorizeArtifactRun = async (
  db: Database,
  principal: Principal,
  artifactId: string,
  workspaceId: string,
  now: Date
): Promise<void> => {
  if (principal.kind !== "user" || principal.workspaceId !== workspaceId) {
    throw new ForbiddenError("runs.start");
  }
  const [artifact] = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.id, artifactId),
        eq(artifacts.workspaceId, workspaceId),
        isNull(artifacts.deletedAt)
      )
    )
    .limit(1);
  if (!artifact) {
    throw new ForbiddenError("runs.start");
  }
  if (
    artifact.ownerUserId === principal.userId ||
    artifact.audience === "workspace" ||
    principal.isAdmin
  ) {
    return;
  }
  const [member] = await db
    .select({ id: artifactMembers.id })
    .from(artifactMembers)
    .where(
      and(
        eq(artifactMembers.artifactId, artifactId),
        eq(artifactMembers.workspaceId, workspaceId),
        eq(artifactMembers.principalKind, "user"),
        eq(artifactMembers.userId, principal.userId),
        isNull(artifactMembers.revokedAt),
        or(
          isNull(artifactMembers.expiresAt),
          gt(artifactMembers.expiresAt, now.toISOString())
        )
      )
    )
    .limit(1);
  if (!member) {
    throw new ForbiddenError("runs.start");
  }
};
