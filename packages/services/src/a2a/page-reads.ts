/**
 * What the connections pages read that no other service answers: a
 * connection's recent tasks in both directions, and whether the caller may
 * change it. Reads only, for a person or a key. Nothing here carries a token.
 */
import type { Database } from "@repo/db";
import {
  a2aConnections,
  a2aOutboundTasks,
  a2aTasks,
} from "@repo/db/schema/a2a";
import { agents } from "@repo/db/schema/agents";
import type { A2aTaskState } from "@repo/db/shared";
import { and, desc, eq } from "drizzle-orm";
import { authorize } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { PeopleLookup } from "../events.ts";
import type { Principal } from "../workspaces.ts";
import { CONNECTION_KIND, effectiveOwner, requireReader } from "./access.ts";

export const PAGE_READ_ACTION = "a2a.read";
export const RECENT_TASKS_LIMIT = 20;

/** One task on a connection. `text` is the message as the peer or our agent wrote it: outside input, show it as plain text. */
export interface ConnectionTask {
  createdAt: string;
  /** Who approved or declined it, by name, when a person did. */
  decidedBy: string | null;
  /** `in` is a peer's message to us, `out` is ours to the peer. */
  direction: "in" | "out";
  id: string;
  runId: string | null;
  state: A2aTaskState;
  statusText: string | null;
  text: string;
}

export interface Manage {
  /** Why the caller may not change the connection, or null when they may. */
  reason: string | null;
  /** Who revoked it, in words: a member's name, "the system" or "the other side". Null when it was not revoked. */
  revokedBy: string | null;
}

export const createPageReads = ({
  db,
  people,
}: {
  db: Database;
  people?: PeopleLookup;
}) => {
  const requireConnection = async (
    connectionId: string,
    workspaceId: string
  ) => {
    const [row] = await db
      .select({
        agentId: a2aConnections.localAgentId,
        id: a2aConnections.id,
        revokedBy: a2aConnections.revokedBy,
      })
      .from(a2aConnections)
      .where(
        and(
          eq(a2aConnections.id, connectionId),
          eq(a2aConnections.workspaceId, workspaceId)
        )
      )
      .limit(1);
    if (!row) {
      throw new ServiceError("not_found", "Connection not found");
    }
    return row;
  };

  const namesOf = async (
    userIds: readonly string[]
  ): Promise<ReadonlyMap<string, string>> => {
    if (!people || userIds.length === 0) {
      return new Map();
    }
    const found = await people(userIds).catch(() => new Map());
    return new Map([...found].map(([id, person]) => [id, person.name]));
  };

  /** Who ended a connection, in words. `revokedBy` holds a user id or the kind of actor that did it. */
  const revokerOf = async (stored: string | null): Promise<string | null> => {
    if (stored === null) {
      return null;
    }
    if (stored === "system") {
      return "the system";
    }
    if (stored === "peer") {
      return "the other side";
    }
    return (await namesOf([stored])).get(stored) ?? "a member";
  };

  /** The latest tasks in both directions, newest first. */
  const recentTasks = async (
    principal: Principal,
    connectionId: string
  ): Promise<ConnectionTask[]> => {
    const reader = requireReader(principal, PAGE_READ_ACTION);
    authorize(reader, PAGE_READ_ACTION, {
      id: connectionId,
      kind: CONNECTION_KIND,
      workspaceId: reader.workspaceId,
    });
    await requireConnection(connectionId, reader.workspaceId);
    const [incoming, outgoing] = await Promise.all([
      db
        .select()
        .from(a2aTasks)
        .where(
          and(
            eq(a2aTasks.connectionId, connectionId),
            eq(a2aTasks.workspaceId, reader.workspaceId)
          )
        )
        .orderBy(desc(a2aTasks.createdAt))
        .limit(RECENT_TASKS_LIMIT),
      db
        .select()
        .from(a2aOutboundTasks)
        .where(
          and(
            eq(a2aOutboundTasks.connectionId, connectionId),
            eq(a2aOutboundTasks.workspaceId, reader.workspaceId)
          )
        )
        .orderBy(desc(a2aOutboundTasks.createdAt))
        .limit(RECENT_TASKS_LIMIT),
    ]);
    const names = await namesOf([
      ...new Set(
        incoming.flatMap((task) => (task.decidedBy ? [task.decidedBy] : []))
      ),
    ]);
    const tasks: ConnectionTask[] = [
      ...incoming.map(
        (task): ConnectionTask => ({
          createdAt: task.createdAt,
          decidedBy: task.decidedBy
            ? (names.get(task.decidedBy) ?? "A member")
            : null,
          direction: "in",
          id: task.id,
          runId: task.runId,
          state: task.state,
          statusText: task.statusText,
          text: task.inputText,
        })
      ),
      ...outgoing.map(
        (task): ConnectionTask => ({
          createdAt: task.createdAt,
          decidedBy: null,
          direction: "out",
          id: task.id,
          runId: task.callingRunId,
          state: task.state,
          statusText: null,
          text: task.text,
        })
      ),
    ];
    return tasks
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, RECENT_TASKS_LIMIT);
  };

  /**
   * Whether the caller may approve or widen a connection: an org admin or the
   * agent's owner, on a browser session. The page shows the switches disabled
   * with the reason otherwise. The services still refuse the call.
   */
  const manage = async (
    principal: Principal,
    connectionId: string
  ): Promise<Manage> => {
    const reader = requireReader(principal, PAGE_READ_ACTION);
    authorize(reader, PAGE_READ_ACTION, {
      id: connectionId,
      kind: CONNECTION_KIND,
      workspaceId: reader.workspaceId,
    });
    const connection = await requireConnection(
      connectionId,
      reader.workspaceId
    );
    const revokedBy = await revokerOf(connection.revokedBy);
    if (reader.via !== "session") {
      return {
        reason: "Only a person signed in to the web app can change this.",
        revokedBy,
      };
    }
    const [agent] = await db
      .select({
        createdBy: agents.createdBy,
        ownerUserId: agents.ownerUserId,
      })
      .from(agents)
      .where(
        and(
          eq(agents.id, connection.agentId),
          eq(agents.workspaceId, reader.workspaceId)
        )
      )
      .limit(1);
    if (!agent) {
      throw new ServiceError("not_found", "Agent not found");
    }
    return reader.isAdmin === true || reader.userId === effectiveOwner(agent)
      ? { reason: null, revokedBy }
      : {
          reason:
            "Only an organisation admin or the agent's owner can change this.",
          revokedBy,
        };
  };

  return { manage, recentTasks };
};

export type PageReads = ReturnType<typeof createPageReads>;
