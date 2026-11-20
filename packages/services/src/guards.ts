import { ForbiddenError } from "./authz.ts";
import type { Principal } from "./workspaces.ts";

/** A person: a browser session, an API key's user, a connected app or Slack. */
export type UserPrincipal = Extract<Principal, { kind: "user" }>;

/** Any person, however they signed in. Everything else is refused. */
export const requireUser = (
  principal: Principal,
  action: string
): UserPrincipal => {
  if (principal.kind !== "user") {
    throw new ForbiddenError(action);
  }
  return principal;
};

/** A person on a signed-in browser session, and nothing else. */
export const requireSession = (
  principal: Principal,
  action: string
): UserPrincipal => {
  if (principal.kind !== "user" || principal.via !== "session") {
    throw new ForbiddenError(action);
  }
  return principal;
};

/** An org admin on a signed-in browser session. */
export const requireAdminSession = (
  principal: Principal,
  action: string
): UserPrincipal => {
  const user = requireSession(principal, action);
  if (user.isAdmin !== true) {
    throw new ForbiddenError(action);
  }
  return user;
};

/** The workspace a non-system principal reads from. */
export const readableWorkspace = (
  principal: Principal,
  action: string
): string => {
  if (principal.kind === "system") {
    throw new ForbiddenError(action);
  }
  return principal.workspaceId;
};

/** Who answers for an agent: its owner, falling back to the person who made it. */
export const effectiveOwner = (agent: {
  createdBy: string;
  ownerUserId: string | null;
}): string => agent.ownerUserId ?? agent.createdBy;

/** An org admin or the agent's owner may act on the agent's own credentials. */
export const requireAgentOwnerOrAdmin = (
  user: UserPrincipal,
  agent: { createdBy: string; ownerUserId: string | null },
  action: string
): void => {
  if (user.isAdmin !== true && user.userId !== effectiveOwner(agent)) {
    throw new ForbiddenError(action);
  }
};

/**
 * Who may change an agent's apps, allowed tools, sign-in mode, Slack app and
 * secret grants. A browser session must be an org admin or the agent's owner.
 * A write key or a connected app keeps the scope check its own path made, so
 * the agent builder and the admin tools still work.
 */
export const requireSessionAgentManager = (
  principal: Principal,
  agent: { createdBy: string; ownerUserId: string | null },
  action: string
): void => {
  if (principal.kind === "user" && principal.via === "session") {
    requireAgentOwnerOrAdmin(principal, agent, action);
  }
};
