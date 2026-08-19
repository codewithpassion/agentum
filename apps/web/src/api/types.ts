/** Shared Hono environment for every authenticated `/api` router. */
export interface ApiEnv {
  Bindings: Env;
  Variables: {
    /** Clerk user id, set by `requireAuth`. */
    userId: string;
  };
}
