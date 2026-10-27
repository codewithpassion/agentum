import type { Principal } from "./workspaces.ts";

/** What a principal wants to act on. `id` is optional: a whole collection has none. */
export interface Resource {
  id?: string;
  kind: string;
  workspaceId: string;
}

/**
 * Whether `principal` may perform `action` on `resource`. Every service method
 * calls this before it touches data. The system principal is trusted in-process.
 * Scoped run principals receive only guarded lifecycle/session/request actions;
 * artifact operations require their separate current-provenance boundary.
 * Every other principal remains confined to its workspace.
 */
export const can = (
  principal: Principal,
  action: string,
  resource: Resource
): boolean => {
  if (principal.kind === "system") {
    return true;
  }
  if (principal.kind === "run" && principal.scopeArtifactId) {
    const ownRun =
      resource.kind === "run" &&
      resource.id === principal.runId &&
      [
        "runs.read",
        "runs.cancel",
        "runs.ingest",
        "runs.heartbeat",
        "runs.complete",
      ].includes(action);
    const guardedRead = [
      "sessions.read",
      "requests.read",
      "requests.write",
    ].includes(action);
    if (!(ownRun || guardedRead)) {
      return false;
    }
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
