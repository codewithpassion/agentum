/**
 * Who may touch an agent connection. Every method of the connections service
 * starts here. Only a person on a browser session creates, approves or widens
 * a connection, so an API key, a connected app, a run, a machine, a trigger and
 * a peer are all refused: a prompt-injected agent must not be able to connect
 * itself to anything.
 */
import { ForbiddenError } from "../authz.ts";
import type { Principal } from "../workspaces.ts";

export type SessionUser = Extract<Principal, { kind: "user" }>;

/** The kind `authorize()` is asked about. */
export const CONNECTION_KIND = "a2a_connection";

/** A signed-in browser session, and nothing else. */
export const requireSession = (
  principal: Principal,
  action: string
): SessionUser => {
  if (principal.kind !== "user" || principal.via !== "session") {
    throw new ForbiddenError(action);
  }
  return principal;
};

/**
 * Anyone who may look at connections: a person on a session, an API key or a
 * connected app. Reads carry no token or credential.
 */
export const requireReader = (
  principal: Principal,
  action: string
): SessionUser => {
  if (principal.kind !== "user" || principal.via === "slack") {
    throw new ForbiddenError(action);
  }
  return principal;
};

/** Who answers for an agent: its owner, falling back to the person who made it. */
export const effectiveOwner = (agent: {
  createdBy: string;
  ownerUserId: string | null;
}): string => agent.ownerUserId ?? agent.createdBy;

/** Creating, approving and widening need an org admin or the agent's owner. */
export const requireAdminOrOwner = (
  user: SessionUser,
  agent: { createdBy: string; ownerUserId: string | null },
  action: string
): void => {
  if (user.isAdmin !== true && user.userId !== effectiveOwner(agent)) {
    throw new ForbiddenError(action);
  }
};
