/**
 * Pins (PRD R2.7): a person pins an artifact to the sidebar or as a desk tile.
 * A pin belongs to one person and one surface. Pinning is for people only, and
 * a pin never reveals an artifact the person could not open.
 */

import type { Database } from "@repo/db";
import {
  deletePin,
  findArtifact,
  insertPin,
  listPins,
  maxPinPosition,
} from "@repo/db/artifact-grants";
import type { Atomic } from "@repo/db/atomic";
import type { ArtifactKind, ArtifactPinSurface } from "@repo/db/shared";
import {
  artifactsPinInputSchema,
  artifactsUnpinInputSchema,
} from "@repo/protocol/artifacts";
import { ulid } from "ulidx";
import { authorize, ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import { canOpen } from "./policy.ts";

type UserPrincipal = Extract<Principal, { kind: "user" }>;

export interface PinnedArtifactView {
  artifactId: string;
  kind: ArtifactKind;
  position: number;
  surface: ArtifactPinSurface;
  title: string;
}

const requireUser = (principal: Principal, action: string): UserPrincipal => {
  if (principal.kind !== "user") {
    throw new ForbiddenError(action);
  }
  return principal;
};

export const createArtifactPinsService = ({
  atomic,
  clock,
  db,
}: {
  atomic: Atomic;
  clock: Clock;
  db: Database;
}) => {
  const pin = async (principal: Principal, input: unknown): Promise<void> => {
    const user = requireUser(principal, "artifacts.pin");
    const { artifactId, surface } = artifactsPinInputSchema.parse(input);
    authorize(user, "artifacts.pin", {
      id: artifactId,
      kind: "artifact",
      workspaceId: user.workspaceId,
    });

    const artifact = await findArtifact(db, {
      id: artifactId,
      workspaceId: user.workspaceId,
    });
    // Not found and not openable look the same, so a private artifact is not revealed.
    if (
      artifact === null ||
      !canOpen(artifact, {
        isAdmin: user.isAdmin === true,
        userId: user.userId,
      })
    ) {
      throw new ServiceError("not_found", "Artifact not found");
    }

    const position =
      (await maxPinPosition(db, {
        surface,
        userId: user.userId,
        workspaceId: user.workspaceId,
      })) + 1;
    await atomic([
      insertPin(db, {
        artifactId,
        createdAt: clock.now().toISOString(),
        id: ulid(),
        position,
        surface,
        userId: user.userId,
        workspaceId: user.workspaceId,
      }),
    ]);
  };

  const unpin = async (principal: Principal, input: unknown): Promise<void> => {
    const user = requireUser(principal, "artifacts.unpin");
    const { artifactId, surface } = artifactsUnpinInputSchema.parse(input);
    authorize(user, "artifacts.unpin", {
      id: artifactId,
      kind: "artifact",
      workspaceId: user.workspaceId,
    });

    await deletePin(db, {
      artifactId,
      surface,
      userId: user.userId,
      workspaceId: user.workspaceId,
    });
  };

  /** The person's pins that they can still open. Pins on deleted artifacts are left out. */
  const list = async (
    principal: Principal,
    query: { surface?: ArtifactPinSurface } = {}
  ): Promise<PinnedArtifactView[]> => {
    const user = requireUser(principal, "artifacts.list");
    authorize(user, "artifacts.list", {
      kind: "artifact",
      workspaceId: user.workspaceId,
    });

    const rows = await listPins(db, {
      surface: query.surface,
      userId: user.userId,
      workspaceId: user.workspaceId,
    });
    return rows
      .filter((row) =>
        canOpen(row, { isAdmin: user.isAdmin === true, userId: user.userId })
      )
      .map((row) => ({
        artifactId: row.artifactId,
        kind: row.kind,
        position: row.position,
        surface: row.surface,
        title: row.title,
      }));
  };

  return { list, pin, unpin };
};

export type ArtifactPinsService = ReturnType<typeof createArtifactPinsService>;
