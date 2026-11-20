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

/** An org admin: a session of an org admin, or an admin key. */
const isOrgAdmin = (user: UserPrincipal): boolean =>
  user.isAdmin === true || user.apiKey?.access === "admin";

/**
 * An org admin or the agent's owner may change the agent's credentials, apps,
 * allowed tools, sign-in mode, Slack app and secret grants. An admin is a
 * session of an org admin or an admin key. A write key or a connected app
 * counts only as the person who owns the agent, since any member can mint one.
 */
export const requireAgentOwnerOrAdmin = (
  user: UserPrincipal,
  agent: { createdBy: string; ownerUserId: string | null },
  action: string
): void => {
  if (!isOrgAdmin(user) && user.userId !== effectiveOwner(agent)) {
    throw new ForbiddenError(action);
  }
};

/**
 * Who may decide a held shared change or answer a dream question: an org
 * admin, the agent's owner, or its backup owner. Anyone else is refused.
 */
export const requireAgentDecider = (
  user: UserPrincipal,
  agent: {
    backupUserId: string | null;
    createdBy: string;
    ownerUserId: string | null;
  },
  action: string
): void => {
  const isBackup =
    agent.backupUserId !== null && user.userId === agent.backupUserId;
  if (
    !(isOrgAdmin(user) || isBackup || user.userId === effectiveOwner(agent))
  ) {
    throw new ForbiddenError(action);
  }
};
