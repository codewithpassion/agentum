import type { Workspace, WorkspaceMember } from "#/modules/workspaces/schema";

/** Shared Hono environment for every authenticated `/api` router. */
export interface ApiEnv {
  Bindings: Env;
  Variables: {
    /**
     * The caller's membership in that workspace, set by `requireWorkspace`.
     * Carries the Clerk user id, so it must never be serialized as-is.
     */
    member: WorkspaceMember;
    /** Clerk user id, set by `requireAuth`. */
    userId: string;
    /** The workspace named by `:slug`, set by `requireWorkspace`. */
    workspace: Workspace;
  };
}
