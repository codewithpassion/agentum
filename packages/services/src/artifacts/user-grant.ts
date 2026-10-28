import type { Database } from "@repo/db";
import { artifactMembers } from "@repo/db/schema/live-artifacts";
import { and, eq, isNull } from "drizzle-orm";

/**
 * Whether a person holds a live member grant on a document or deck: not
 * revoked and not expired. The grant is what lets a user open a private
 * artifact page they did not make.
 */
export const hasUserGrant = async (
  db: Database,
  artifact: { id: string; kind: string; workspaceId: string },
  userId: string,
  now: string
): Promise<boolean> => {
  if (artifact.kind !== "document" && artifact.kind !== "deck") {
    return false;
  }
  const [grant] = await db
    .select({ expiresAt: artifactMembers.expiresAt })
    .from(artifactMembers)
    .where(
      and(
        eq(artifactMembers.workspaceId, artifact.workspaceId),
        eq(artifactMembers.artifactId, artifact.id),
        eq(artifactMembers.principalKind, "user"),
        eq(artifactMembers.userId, userId),
        isNull(artifactMembers.revokedAt)
      )
    )
    .limit(1);
  return Boolean(grant && (!grant.expiresAt || grant.expiresAt > now));
};
