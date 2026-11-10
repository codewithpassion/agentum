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
