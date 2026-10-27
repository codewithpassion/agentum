import type { Database } from "@repo/db";
import { ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import { createLiveAccess } from "../live-artifacts/access.ts";
import { canComment } from "../live-artifacts/shared.ts";
import type { Principal } from "../workspaces.ts";

/** Recheck current live access for direct starts and trusted continuations too. */
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
  const { access } = createLiveAccess({
    clock: { now: () => now },
    db,
  });
  const { row, role } = await access(
    principal,
    artifactId,
    false,
    false,
    false
  );
  if (!["document", "deck", "page", "dashboard"].includes(row.kind)) {
    throw new ServiceError("not_found", "Artifact not found");
  }
  canComment(role);
};
