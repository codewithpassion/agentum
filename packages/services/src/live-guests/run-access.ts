/** Current scoped authority for tool/service boundaries, never an envelope claim. */
import type { Database } from "@repo/db";
import { artifacts } from "@repo/db/schema/artifacts";
import {
  artifactMembers,
  guestRunScopes,
} from "@repo/db/schema/live-artifacts";
import { runs } from "@repo/db/schema/runs";
import { and, eq } from "drizzle-orm";
import { currentGuestRun, guestUnavailable } from "../runs/guest-scope.ts";
import type { Clock } from "../runs/types.ts";
import type { RunsService } from "../runs.ts";
import type { Principal } from "../workspaces.ts";

export const createGuestRunAccess =
  (deps: {
    db: Database;
    clock: Clock;
    guestsOff: () => boolean;
    runs: Pick<RunsService, "authorizeScopedRun">;
  }) =>
  async (principal: Principal, artifactId: string, write = false) => {
    if (principal.kind !== "run" || deps.guestsOff()) {
      throw guestUnavailable();
    }
    await deps.runs.authorizeScopedRun(principal, principal.runId);
    const [row] = await deps.db
      .select({ kind: artifacts.kind, role: artifactMembers.role })
      .from(runs)
      .innerJoin(
        guestRunScopes,
        and(
          eq(guestRunScopes.runId, runs.id),
          eq(guestRunScopes.workspaceId, runs.workspaceId)
        )
      )
      .innerJoin(
        artifactMembers,
        and(
          eq(artifactMembers.id, guestRunScopes.memberId),
          eq(artifactMembers.workspaceId, runs.workspaceId)
        )
      )
      .innerJoin(
        artifacts,
        and(
          eq(artifacts.id, runs.scopeArtifactId),
          eq(artifacts.workspaceId, runs.workspaceId)
        )
      )
      .where(
        and(
          eq(runs.id, principal.runId),
          eq(runs.workspaceId, principal.workspaceId),
          eq(runs.agentId, principal.agentId),
          eq(runs.scopeArtifactId, artifactId),
          eq(runs.status, "running"),
          currentGuestRun(deps.clock.now().toISOString())
        )
      )
      .limit(1);
    if (
      !row ||
      (row.kind !== "document" && row.kind !== "deck") ||
      row.role === "viewer" ||
      (write && row.role !== "editor") ||
      deps.guestsOff()
    ) {
      throw guestUnavailable();
    }
    return { kind: row.kind, role: row.role as "commenter" | "editor" };
  };
