import type { Principal } from "./workspaces.ts";

/** What a principal wants to act on. `id` is optional: a whole collection has none. */
export interface Resource {
  id?: string;
  kind: string;
  workspaceId: string;
}

/**
 * Whether `principal` may perform `action` on `resource`. Every service method
 * calls this before it touches data. In v1 the rule is workspace isolation: the
 * `system` principal (the in-process minute tick) passes, and every other
 * principal passes only inside its own workspace. Later versions will look at
 * `action` too.
 */
export const can = (
  principal: Principal,
  _action: string,
  resource: Resource
): boolean => {
  if (principal.kind === "system") {
    return true;
  }
  return principal.workspaceId === resource.workspaceId;
};

export class ForbiddenError extends Error {
  override readonly name = "ForbiddenError";
  readonly code = "forbidden" as const;

  constructor(action: string) {
    super(`Not allowed: ${action}`);
  }
}

export const isForbiddenError = (error: unknown): error is ForbiddenError =>
  error instanceof ForbiddenError;

/** Throws `ForbiddenError` when `can` says no. */
export const authorize = (
  principal: Principal,
  action: string,
  resource: Resource
): void => {
  if (!can(principal, action, resource)) {
    throw new ForbiddenError(action);
  }
};
