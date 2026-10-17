/**
 * Who may manage routines and triggers, and how a change is logged. Both
 * services share it.
 *
 * A person (a signed-in session, an API key or a connected app) acts as
 * themselves, and a read-only key or app only lists. An agent's run may list
 * and create for its own agent, and what it creates is a proposal that waits
 * for a person to approve it (see `isPendingProposal`).
 */
import type { TriggerKind } from "@repo/db/shared";
import { ForbiddenError } from "./authz.ts";
import type { EventsService } from "./events.ts";
import type { Principal } from "./workspaces.ts";

export type UserPrincipal = Extract<Principal, { kind: "user" }>;
export type RunPrincipal = Extract<Principal, { kind: "run" }>;
/** A principal that may reach routines and triggers at all. */
export type Manager = UserPrincipal | RunPrincipal;

/** A user on a read-only API key or connected app. */
export const isReadOnly = (principal: Principal): boolean =>
  principal.kind === "user" &&
  (principal.apiKey?.access === "read" ||
    principal.oauthClient?.access === "read");

/** A person or a run. Machines, triggers, Slack senders and the tick are refused. */
export const requireReader = (
  principal: Principal,
  action: string
): Manager => {
  if (principal.kind === "run") {
    return principal;
  }
  if (principal.kind === "user" && principal.via !== "slack") {
    return principal;
  }
  throw new ForbiddenError(action);
};

/** A person or a run that may change things: not a read-only key or app. */
export const requireWriter = (
  principal: Principal,
  action: string
): Manager => {
  const manager = requireReader(principal, action);
  if (isReadOnly(manager)) {
    throw new ForbiddenError(action);
  }
  return manager;
};

/** A person who may change things. Approving and rejecting a proposal is theirs alone. */
export const requireApprover = (
  principal: Principal,
  action: string
): UserPrincipal => {
  const manager = requireWriter(principal, action);
  if (manager.kind !== "user") {
    throw new ForbiddenError(action);
  }
  return manager;
};

/** A run works on its own agent only. */
export const requireOwnAgent = (
  manager: Manager,
  agentId: string,
  action: string
): void => {
  if (manager.kind === "run" && manager.agentId !== agentId) {
    throw new ForbiddenError(action);
  }
};

/** What `triggers.created_by` holds: the user, or the run that proposed it. */
export const createdByOf = (manager: Manager): string =>
  manager.kind === "run" ? manager.runId : manager.userId;

/** The proposal columns for a row a run creates, and nulls for one a person creates. */
export const proposalColumns = (manager: Manager) =>
  manager.kind === "run"
    ? { proposedByAgentId: manager.agentId, proposedByRunId: manager.runId }
    : { proposedByAgentId: null, proposedByRunId: null };

/** The principal as the log names it: ids only, never a secret. */
const principalPayload = (manager: Manager): Record<string, string> => {
  if (manager.kind === "run") {
    return { agentId: manager.agentId, runId: manager.runId, via: "run" };
  }
  return {
    userId: manager.userId,
    via: manager.via,
    ...(manager.apiKey ? { keyId: manager.apiKey.id } : {}),
    ...(manager.oauthClient ? { clientId: manager.oauthClient.clientId } : {}),
  };
};

export type AutomationChange = "approved" | "created" | "deleted" | "rejected";

/** Writes the event for a change to a routine or trigger, naming who made it. */
export const recordChange = async (
  events: EventsService,
  manager: Manager,
  change: {
    agentId: string;
    change: AutomationChange;
    kind: TriggerKind;
    name: string;
    /** For `created`: the row waits for approval. */
    proposed?: boolean;
    triggerId: string;
    workspaceId: string;
  }
): Promise<void> => {
  await events.append({
    actor:
      manager.kind === "run"
        ? { id: manager.agentId, kind: "agent" }
        : { id: manager.userId, kind: "user" },
    agentId: change.agentId,
    payload: {
      kind: change.kind,
      name: change.name,
      principal: principalPayload(manager),
      proposed: change.proposed ?? false,
      triggerId: change.triggerId,
    },
    runId: manager.kind === "run" ? manager.runId : null,
    type: `trigger.${change.change}`,
    workspaceId: change.workspaceId,
  });
};
