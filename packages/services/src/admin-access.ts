import type { ApiKeyAccess } from "@repo/db/shared";
import { ForbiddenError } from "./authz.ts";
import type { Principal } from "./workspaces.ts";

type UserPrincipal = Extract<Principal, { kind: "user" }>;

/** A user principal that came in with an API key. */
export type KeyPrincipal = UserPrincipal & {
  apiKey: NonNullable<UserPrincipal["apiKey"]>;
  via: "api_key";
};

/** The weakest key that may make a call. */
export type KeyLevel = "admin" | "write";

const LEVELS: Record<KeyLevel, readonly ApiKeyAccess[]> = {
  admin: ["admin"],
  write: ["write", "admin"],
};

/** The key behind `principal` when it may make a `level` call, else a `ForbiddenError`. */
export const requireKey = (
  principal: Principal,
  action: string,
  level: KeyLevel
): KeyPrincipal => {
  if (
    principal.kind !== "user" ||
    principal.via !== "api_key" ||
    !principal.apiKey ||
    !LEVELS[level].includes(principal.apiKey.access)
  ) {
    throw new ForbiddenError(action);
  }
  return principal as KeyPrincipal;
};

/** How much a key may do. A desk key reaches the desk API only, so it ranks with read. */
const RANK: Record<ApiKeyAccess, number> = {
  admin: 3,
  desk: 1,
  read: 1,
  write: 2,
};

/** Whether a caller with `own` access may mint a key with `requested` access. */
export const withinScope = (
  own: ApiKeyAccess,
  requested: ApiKeyAccess
): boolean => RANK[requested] <= RANK[own];

/** Agent management admits a person's write OAuth connection as well as a write key. */
export type AgentManager =
  | KeyPrincipal
  | (UserPrincipal & {
      oauthClient: NonNullable<UserPrincipal["oauthClient"]>;
      via: "oauth";
    });

export const requireAgentManager = (
  principal: Principal,
  action: string
): AgentManager => {
  if (
    principal.kind === "user" &&
    principal.via === "oauth" &&
    principal.oauthClient?.access === "write"
  ) {
    return principal as AgentManager;
  }
  return requireKey(principal, action, "write");
};
