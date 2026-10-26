/**
 * Who may use the key-authenticated admin API (X.10). Only an `hm_key_` key
 * does: a signed-in person has the UI, a run or a connected app has no way
 * in. Setup calls need an `admin` key; creating agents and inbox threads also
 * takes a `write` key.
 */
import type { ApiKeyAccess } from "@repo/db/shared";
import { ForbiddenError } from "./authz.ts";
import type { Principal } from "./workspaces.ts";

type UserPrincipal = Extract<Principal, { kind: "user" }>;

/** A user principal that came in with an API key. */
export type KeyPrincipal = UserPrincipal & {
  apiKey: NonNullable<UserPrincipal["apiKey"]>;
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
