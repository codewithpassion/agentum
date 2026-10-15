// Builds a tRPC context from a database and a Clerk session. Kept free of
// Clerk and cloudflare:workers imports so bun can test it directly.
import type { Database } from "@repo/db";
import { createWorkspacesService } from "@repo/services/workspaces";
import type { Context } from "./context.ts";

/** Splits a comma separated list of ids, trimmed, dropping empty entries. */
export const parseOrgIds = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

export const buildContext = async ({
  allowedOrgIds,
  db,
  session,
}: {
  allowedOrgIds: readonly string[];
  db: Database;
  session: { orgId?: string | null; userId: string | null };
}): Promise<Context> => {
  const workspaces = createWorkspacesService({ allowedOrgIds, db });
  const principal =
    session.userId === null
      ? null
      : await workspaces.sessionPrincipal({
          orgId: session.orgId,
          userId: session.userId,
        });
  return { principal, services: { workspaces } };
};
