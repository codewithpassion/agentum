import type { Database } from "@repo/db";
import { artifactGrants, artifactVersions } from "@repo/db/schema/artifacts";
import { and, desc, eq, exists, gt, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

/** Only a current version or another person's actionable proposal replaces a grant card. */
export const replacementVersions = (
  db: Database,
  version: { artifactId: SQL; currentVersionId: SQL; number: SQL }
) => {
  const newer = alias(artifactVersions, "newer");
  const grants = alias(artifactGrants, "newer_grants");
  return db
    .select({ number: newer.number })
    .from(newer)
    .where(
      and(
        eq(newer.artifactId, version.artifactId),
        gt(newer.number, version.number),
        or(
          eq(newer.id, version.currentVersionId),
          and(
            eq(newer.status, "proposed"),
            eq(newer.authorKind, "user"),
            exists(
              db
                .select({ id: grants.id })
                .from(grants)
                .where(
                  and(
                    eq(grants.versionId, newer.id),
                    eq(grants.status, "pending")
                  )
                )
            )
          )
        )
      )
    )
    .orderBy(desc(newer.number));
};
