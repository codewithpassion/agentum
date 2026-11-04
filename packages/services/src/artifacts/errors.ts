import type { Database } from "@repo/db";
import { findArtifact } from "@repo/db/artifact-grants";
import { artifactVersions } from "@repo/db/schema/artifacts";
import { events as eventRows } from "@repo/db/schema/events";
import { and, desc, eq, sql } from "drizzle-orm";
import { authorize } from "../authz.ts";
import type { EventsService } from "../events.ts";
import type { Principal } from "../workspaces.ts";
import { agentCanUpdate, canManage } from "./policy.ts";

export interface AppErrorTarget {
  artifactId: string;
  versionId: string;
  workspaceId: string;
}
export type AppErrorSlot = (
  artifactId: string,
  /** Restore a failed append's drops, including that failed event, without claiming a slot. */
  restoreDropped?: number
) => Promise<{ dropped: number } | null>;

export const createArtifactErrorsService = ({
  db,
  events,
  slot,
}: {
  db: Database;
  events: EventsService;
  slot?: AppErrorSlot;
}) => ({
  list: async (principal: Principal, artifactId: string) => {
    if (principal.kind === "system") {
      return;
    }
    authorize(principal, "artifacts.read", {
      id: artifactId,
      kind: "artifact",
      workspaceId: principal.workspaceId,
    });
    const artifact = await findArtifact(db, {
      id: artifactId,
      workspaceId: principal.workspaceId,
    });
    if (!artifact) {
      return;
    }
    const allowed =
      principal.kind === "user"
        ? canManage(artifact, {
            isAdmin: principal.isAdmin === true,
            userId: principal.userId,
          })
        : principal.kind === "run" &&
          agentCanUpdate(artifact, principal.agentId);
    if (!allowed) {
      return;
    }
    const rows = await db
      .select({
        payload: eventRows.payload,
        time: eventRows.createdAt,
        version: artifactVersions.number,
      })
      .from(eventRows)
      .innerJoin(
        artifactVersions,
        eq(
          artifactVersions.id,
          sql`json_extract(${eventRows.payload}, '$.versionId')`
        )
      )
      .where(
        and(
          eq(eventRows.workspaceId, principal.workspaceId),
          eq(eventRows.type, "app.error"),
          sql`json_extract(${eventRows.payload}, '$.artifactId') = ${artifactId}`
        )
      )
      .orderBy(desc(eventRows.id))
      .limit(10);
    return rows.map((row) => {
      const payload = JSON.parse(row.payload ?? "{}");
      return {
        dropped: Number(payload.dropped ?? 0),
        entry: String(payload.entry),
        message: String(payload.message),
        time: row.time,
        version: row.version,
        versionId: String(payload.versionId),
      };
    });
  },
  record: async (
    target: AppErrorTarget,
    entry: string,
    error: unknown
  ): Promise<void> => {
    // Diagnostics must never change the app's fixed error response. Without
    // the durable flood guard, fail closed instead of flooding events.
    let dropped: number | undefined;
    try {
      const admitted = await slot?.(target.artifactId);
      if (admitted === null || admitted === undefined) {
        return;
      }
      ({ dropped } = admitted);
      await events.append({
        actor: { id: "system", kind: "system" },
        payload: {
          ...target,
          dropped: admitted.dropped,
          entry,
          message: (error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, 500),
        },
        type: "app.error",
        workspaceId: target.workspaceId,
      });
    } catch {
      if (dropped !== undefined) {
        await slot?.(target.artifactId, dropped + 1).catch(() => undefined);
      }
      // The error recorder is best effort, including during storage outages.
    }
  },
});
