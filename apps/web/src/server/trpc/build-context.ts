// Builds a tRPC context from the composed services and a Clerk session. Kept
// free of Clerk and cloudflare:workers imports so bun can test it directly.
import type { Composed } from "../compose.ts";
import type { Context } from "./context.ts";

export const buildContext = async ({
  composed: { services },
  session,
}: {
  composed: Composed;
  session: { orgId?: string | null; userId: string | null };
}): Promise<Context> => {
  const principal =
    session.userId === null
      ? null
      : await services.workspaces.sessionPrincipal({
          orgId: session.orgId,
          userId: session.userId,
        });
  return { principal, services };
};
