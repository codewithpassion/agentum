// Builds a tRPC context from the composed services and a Clerk session. Kept
// free of Clerk and cloudflare:workers imports so bun can test it directly.
import type { Composed } from "../compose.ts";
import type { Context } from "./context.ts";

export const buildContext = async ({
  composed: { services },
  session,
}: {
  composed: Composed;
  session: {
    /** The user of the session even when it is `pending`. Defaults to `userId`. */
    anyUserId?: string | null;
    orgId?: string | null;
    orgRole?: string | null;
    /** The user of the session, null when it is signed out or `pending`. The principal comes from this one. */
    userId: string | null;
  };
}): Promise<Context> => {
  const principal =
    session.userId === null
      ? null
      : await services.workspaces.sessionPrincipal({
          orgId: session.orgId,
          orgRole: session.orgRole,
          userId: session.userId,
        });
  return {
    principal,
    services,
    userId: session.anyUserId ?? session.userId,
  };
};
