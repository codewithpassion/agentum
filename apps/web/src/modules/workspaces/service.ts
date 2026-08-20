/**
 * The workspace every row created before multi-tenancy belongs to. The literal
 * matches the row migration 0012 inserts, which is what lets a route name a
 * workspace before `requireWorkspace` exists to resolve one from the URL.
 *
 * Phase 2 replaces every use of this with the workspace on the request context.
 */
export const DEFAULT_WORKSPACE_ID = "ws_default";
