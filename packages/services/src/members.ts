/**
 * The members of a workspace's Clerk organisation. The app implements
 * `MemberLister` with Clerk; tests pass a fake. The rail, the owner picker and
 * `agents.setOwners` read through this one service.
 */
import type { Database } from "@repo/db";
import { workspaces } from "@repo/db/schema/workspaces";
import type { WorkspaceMember } from "@repo/db/shared";
import { eq } from "drizzle-orm";
import { authorize, ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import type { Principal } from "./workspaces.ts";

/** Everyone in the Clerk organisation `clerkOrgId`, in any order. */
export type MemberLister = (clerkOrgId: string) => Promise<WorkspaceMember[]>;

const READ_ACTION = "members.read";
const MEMBERS_KIND = "members";

const byName = (a: WorkspaceMember, b: WorkspaceMember): number =>
  a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId);

export const createMembersService = ({
  db,
  lister,
}: {
  db: Database;
  lister?: MemberLister;
}) => {
  /**
   * The members of the caller's workspace, sorted by name. Throws when no
   * lister is wired or Clerk fails: callers decide what an unknown list means.
   */
  const list = async (principal: Principal): Promise<WorkspaceMember[]> => {
    if (principal.kind !== "user") {
      throw new ForbiddenError(READ_ACTION);
    }
    authorize(principal, READ_ACTION, {
      kind: MEMBERS_KIND,
      workspaceId: principal.workspaceId,
    });
    if (!lister) {
      throw new ServiceError("invalid", "Members are not available here");
    }
    const [workspace] = await db
      .select({ clerkOrgId: workspaces.clerkOrgId })
      .from(workspaces)
      .where(eq(workspaces.id, principal.workspaceId));
    if (!workspace) {
      throw new ServiceError("not_found", "Workspace not found");
    }
    return [...(await lister(workspace.clerkOrgId))].sort(byName);
  };

  return { list };
};

export type MembersService = ReturnType<typeof createMembersService>;
