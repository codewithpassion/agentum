import type { Database } from "@repo/db";
import {
  endpointById,
  endpointsForArtifact,
  ensureEndpointStatement,
  insertEndpointStatement,
  insertEndpointView,
  resolveEndpoint,
  setEndpointDisabledStatement,
} from "@repo/db/artifact-endpoints";
import { findArtifact } from "@repo/db/artifact-grants";
import type { Atomic } from "@repo/db/atomic";
import type { ArtifactViewOutcome } from "@repo/db/shared";
import { ulid } from "ulidx";
import { authorize, ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { Principal } from "../workspaces.ts";

const TRAILING_SLASH = /\/$/;

export const endpointId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_");
};

export const createArtifactEndpointsService = ({
  db,
  atomic,
  clock,
  publicBaseUrl = "",
}: {
  db: Database;
  atomic: Atomic;
  clock: { now: () => Date };
  publicBaseUrl?: string;
}) => {
  const requireManager = async (principal: Principal, artifactId: string) => {
    if (principal.kind !== "user" || principal.via !== "session") {
      throw new ForbiddenError("artifacts.grants");
    }
    authorize(principal, "artifacts.grants", {
      id: artifactId,
      kind: "artifact",
      workspaceId: principal.workspaceId,
    });
    const artifact = await findArtifact(db, {
      id: artifactId,
      workspaceId: principal.workspaceId,
    });
    if (
      artifact?.kind !== "app" ||
      !(principal.isAdmin || artifact.ownerUserId === principal.userId)
    ) {
      throw new ServiceError("not_found", "Artifact not found");
    }
    return artifact;
  };
  const present = (
    row: NonNullable<Awaited<ReturnType<typeof endpointById>>>
  ) => ({
    disabledAt: row.disabledAt,
    id: row.id,
    name: row.name,
    url: `${publicBaseUrl.replace(TRAILING_SLASH, "")}/hooks/${row.id}`,
  });
  const ensure = async (
    artifactId: string,
    workspaceId: string,
    name: string
  ) => {
    await atomic([
      ensureEndpointStatement(db, {
        artifactId,
        createdAt: clock.now().toISOString(),
        id: endpointId(),
        name,
        workspaceId,
      }),
    ]);
  };
  const list = async (principal: Principal, artifactId: string) => {
    await requireManager(principal, artifactId);
    return (await endpointsForArtifact(db, artifactId)).map(present);
  };
  const change = async (
    principal: Principal,
    id: string,
    action: "disable" | "enable" | "rotate"
  ) => {
    const row = await endpointById(db, id);
    if (!row) {
      throw new ServiceError("not_found", "Endpoint not found");
    }
    await requireManager(principal, row.artifactId);
    if (action !== "disable") {
      const siblings = await endpointsForArtifact(db, row.artifactId);
      if (
        siblings.some(
          (other) =>
            other.id !== id &&
            other.name === row.name &&
            other.disabledAt === null
        )
      ) {
        throw new ServiceError(
          "conflict",
          "This endpoint name already has an active address"
        );
      }
    }
    const now = clock.now().toISOString();
    if (action === "rotate") {
      const next = {
        ...row,
        createdAt: now,
        disabledAt: null,
        id: endpointId(),
      };
      await atomic([
        setEndpointDisabledStatement(db, id, now),
        insertEndpointStatement(db, next),
      ]);
      return present(next);
    }
    await atomic([
      setEndpointDisabledStatement(db, id, action === "disable" ? now : null),
    ]);
    return present({ ...row, disabledAt: action === "disable" ? now : null });
  };
  const recordCall = async (
    id: string,
    meta: {
      ipPrefix: string | null;
      place: string | null;
      userAgent: string | null;
      visitorHash: string;
    },
    outcome: ArtifactViewOutcome
  ) => {
    const row = await endpointById(db, id);
    // Unknown ids cannot be audited: artifact_views requires an artifact FK.
    if (!row) {
      return;
    }
    const artifact = await findArtifact(db, {
      id: row.artifactId,
      workspaceId: row.workspaceId,
    });
    // EP.1 has no endpoint surface. live_call records server ingress without a person/share.
    await insertEndpointView(db, {
      artifactId: row.artifactId,
      createdAt: clock.now().toISOString(),
      id: ulid(),
      ipPrefix: meta.ipPrefix,
      outcome,
      surface: "live_call",
      userAgent: meta.userAgent,
      versionId: artifact?.currentVersionId,
      visitorHash: meta.visitorHash || null,
      workspaceId: row.workspaceId,
    });
  };
  return {
    change,
    ensure,
    list,
    recordCall,
    resolve: (id: string) => resolveEndpoint(db, id),
    workspaceIdOf: async (id: string) =>
      (await endpointById(db, id))?.workspaceId ?? null,
  };
};
export type ArtifactEndpointsService = ReturnType<
  typeof createArtifactEndpointsService
>;
