import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { artifacts } from "@repo/db/schema/artifacts";
import { workspaces } from "@repo/db/schema/workspaces";
import { and, eq, inArray } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import type { EventsService } from "../events.ts";
import { roomInvalidationStatement } from "../live-artifacts/access-lifecycle.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
export const createGuestSwitch =
  (deps: {
    db: Database;
    atomic: Atomic;
    clock: Clock;
    events: Pick<EventsService, "insertStatement">;
    invalidations: { trigger: () => Promise<void> };
  }) =>
  async (principal: Principal, enabled: boolean) => {
    if (
      principal.kind !== "user" ||
      !principal.isAdmin ||
      principal.apiKey ||
      principal.oauthClient
    ) {
      throw new ForbiddenError("guests.switch");
    }
    const rows = await deps.db
      .select({ artifactId: artifacts.id, workspaceId: artifacts.workspaceId })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.workspaceId, principal.workspaceId),
          inArray(artifacts.kind, ["document", "deck"])
        )
      );
    await deps.atomic([
      deps.db
        .update(workspaces)
        .set({ liveGuestsEnabled: enabled })
        .where(eq(workspaces.id, principal.workspaceId)),
      ...rows.map((row) => roomInvalidationStatement(deps, row)),
      deps.events.insertStatement({
        actor: { id: principal.userId, kind: "user" },
        payload: { enabled },
        type: "artifact.guests_switched",
        workspaceId: principal.workspaceId,
      }),
    ]);
    await deps.invalidations.trigger();
    return { enabled };
  };
