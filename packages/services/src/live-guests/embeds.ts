/** Delegated read of an exact, currently retained deck source. A guest never
 * becomes a workspace Principal and cannot enumerate the source workspace. */
import type { Database } from "@repo/db";
import {
  findGuestSessionGrant,
  findGuestSessionReferenceGrant,
} from "@repo/db/live-guests";
import {
  artifacts,
  artifactVersionFiles,
  artifactVersions,
} from "@repo/db/schema/artifacts";
import type { ViewTokenClaims } from "@repo/protocol/artifacts";
import { parseEmbedSource } from "@repo/protocol/deck";
import { and, eq, isNull } from "drizzle-orm";
import { hashToken } from "../crypto.ts";
import { ServiceError } from "../errors.ts";
import type { Clock } from "../runs/types.ts";
import type { GuestCredential } from "./artifacts.ts";

const denied = () => new ServiceError("not_found", "Guest embed unavailable");
export const createGuestEmbeds = (deps: {
  db: Database;
  clock: Clock;
  guestsOff: () => boolean;
  retained: (scope: {
    artifactId: string;
    workspaceId: string;
  }) => Promise<string[]>;
}) => {
  const eligible = async (
    scope: { artifactId: string; workspaceId: string },
    value: string
  ) => {
    const source = parseEmbedSource(value);
    if (!source) {
      return false;
    }
    const [row] = await deps.db
      .select({ id: artifacts.id })
      .from(artifacts)
      .innerJoin(
        artifactVersions,
        and(
          eq(artifactVersions.artifactId, artifacts.id),
          eq(artifactVersions.workspaceId, artifacts.workspaceId)
        )
      )
      .innerJoin(
        artifactVersionFiles,
        and(
          eq(artifactVersionFiles.versionId, artifactVersions.id),
          eq(artifactVersionFiles.workspaceId, artifacts.workspaceId)
        )
      )
      .where(
        and(
          eq(artifacts.workspaceId, scope.workspaceId),
          eq(artifacts.id, source.artifactId),
          eq(artifacts.kind, "page"),
          eq(artifacts.audience, "workspace"),
          isNull(artifacts.deletedAt),
          eq(artifactVersions.id, source.versionId),
          eq(artifactVersions.status, "published"),
          eq(artifactVersionFiles.path, source.path),
          eq(artifactVersionFiles.sha256, source.sha256)
        )
      )
      .limit(1);
    if (!row) {
      return false;
    }
    const [deck] = await deps.db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.workspaceId, scope.workspaceId),
          eq(artifacts.id, scope.artifactId),
          eq(artifacts.kind, "deck"),
          isNull(artifacts.deletedAt)
        )
      )
      .limit(1);
    return Boolean(deck && (await deps.retained(scope)).includes(value));
  };
  return {
    async authorize(claims: ViewTokenClaims): Promise<boolean> {
      const ref = claims.guestEmbed;
      if (
        deps.guestsOff() ||
        !ref ||
        !claims.embedFile ||
        claims.viewer !== "link" ||
        claims.userId ||
        claims.shareId ||
        claims.expiresAt <= Math.floor(deps.clock.now().getTime() / 1000)
      ) {
        return false;
      }
      const scope = { artifactId: ref.deckId, workspaceId: claims.workspaceId };
      const grant = await findGuestSessionReferenceGrant(deps.db, {
        ...scope,
        at: deps.clock.now().toISOString(),
        sessionId: ref.sessionId,
      });
      return Boolean(
        grant &&
          grant.guestId === ref.guestId &&
          grant.memberId === ref.memberId &&
          (await eligible(
            scope,
            `artifact:${claims.artifactId}:${claims.versionId}:${claims.embedFile.sha256}:${claims.embedFile.path}`
          ))
      );
    },
    async resolve(
      input: GuestCredential,
      value: string
    ): Promise<ViewTokenClaims> {
      if (deps.guestsOff()) {
        throw denied();
      }
      const grant = await findGuestSessionGrant(deps.db, {
        ...input,
        at: deps.clock.now().toISOString(),
        tokenHash: await hashToken(input.sessionToken),
      });
      const source = parseEmbedSource(value);
      if (!(grant?.expiresAt && source && (await eligible(input, value)))) {
        throw denied();
      }
      return {
        artifactId: source.artifactId,
        embedFile: { path: source.path, sha256: source.sha256 },
        expiresAt: Math.min(
          Math.floor(deps.clock.now().getTime() / 1000) + 60,
          Math.floor(Date.parse(grant.expiresAt) / 1000),
          Math.floor(Date.parse(grant.sessionExpiresAt) / 1000)
        ),
        guestEmbed: {
          deckId: input.artifactId,
          guestId: grant.guestId,
          memberId: grant.memberId,
          sessionId: grant.sessionId,
        },
        versionId: source.versionId,
        viewer: "link",
        workspaceId: input.workspaceId,
      };
    },
  };
};
