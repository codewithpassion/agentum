import type { Database } from "@repo/db";
import type { EventActorKind } from "@repo/db/shared";
import { ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { Principal } from "../workspaces.ts";
import { loadRun } from "./queries.ts";

/** A run started by a run may nest this deep: depth 0 is the human's, 3 the last. */
export const MAX_RUN_DEPTH = 3;

export const START_ACTION = "runs.start";

export interface Actor {
  id: string;
  kind: EventActorKind;
}

/** Who a run is for, taken from the principal and never from the input. */
export interface Subject {
  actor: Actor;
  depth: number;
  onBehalfOfUserId: string | null;
  parentRunId: string | null;
}

/** How a principal shows up as the actor of an event it caused. */
export const eventActor = (principal: Principal): Actor => {
  switch (principal.kind) {
    case "user":
      return { id: principal.userId, kind: "user" };
    case "run":
      return { id: principal.agentId, kind: "agent" };
    case "trigger":
      return { id: principal.triggerId, kind: "trigger" };
    case "machine":
      return { id: principal.machineId, kind: "system" };
    default:
      return { id: "tick", kind: "system" };
  }
};

/** A run principal's subject comes from its parent run, which it cannot change. */
const subjectOfRun = async (
  db: Database,
  principal: Extract<Principal, { kind: "run" }>
): Promise<Subject> => {
  const parent = await loadRun(db, principal.runId, principal.workspaceId);
  if (!parent) {
    throw new ServiceError("not_found", "Parent run not found");
  }
  if (parent.agentId !== principal.agentId) {
    throw new ForbiddenError(START_ACTION);
  }
  const depth = parent.depth + 1;
  if (depth > MAX_RUN_DEPTH) {
    throw new ServiceError(
      "invalid",
      `Runs can start other runs ${MAX_RUN_DEPTH} levels deep, no more`
    );
  }
  return {
    actor: { id: principal.agentId, kind: "agent" },
    depth,
    onBehalfOfUserId: parent.onBehalfOfUserId,
    parentRunId: parent.id,
  };
};

/**
 * The actor, the person the run is for, and the place in the run tree, for a
 * run started by `principal` on `agentId`.
 */
export const deriveSubject = async (
  db: Database,
  principal: Principal,
  agentId: string
): Promise<Subject> => {
  switch (principal.kind) {
    case "user":
      return {
        actor: { id: principal.userId, kind: "user" },
        depth: 0,
        onBehalfOfUserId: principal.userId,
        parentRunId: null,
      };
    case "run":
      return await subjectOfRun(db, principal);
    case "trigger":
      // A trigger token belongs to one agent.
      if (principal.agentId !== agentId) {
        throw new ForbiddenError(START_ACTION);
      }
      return {
        actor: { id: principal.triggerId, kind: "trigger" },
        depth: 0,
        onBehalfOfUserId: null,
        parentRunId: null,
      };
    case "system":
      return {
        actor: { id: "tick", kind: "system" },
        depth: 0,
        onBehalfOfUserId: null,
        parentRunId: null,
      };
    default:
      throw new ForbiddenError(START_ACTION);
  }
};
