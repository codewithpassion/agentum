import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { workspaceMembers } from "./schema";

/**
 * Turning a stored Clerk user id into something that may leave the server.
 *
 * Storage keeps the Clerk id - it is stable across membership churn and re-adds,
 * where `workspace_members.id` is not - so every view that would show a human
 * resolves it here first, exactly as messaging resolves agent authors through
 * the agents module's service.
 *
 * This lives beside `service.ts` rather than in it because `service.ts` imports
 * the other modules for the workspace-delete cascade (messaging among them):
 * having messaging import back into it would close an import cycle. Nothing in
 * here reaches past this module's own table.
 */

/** A human, as the client is allowed to see one. Never carries the Clerk id. */
export interface MemberAuthorView {
  email: string | null;
  imageUrl: string | null;
  /** `null` once the membership is gone - see `FORMER_MEMBER_NAME`. */
  memberId: string | null;
  name: string;
}

/** Somebody who wrote here and has since been removed from the workspace. */
export const FORMER_MEMBER_NAME = "Former member";

/**
 * A member whose snapshot has neither name nor email yet: migration 0012 made
 * memberships out of existing data, and the Clerk refresh that fills them in
 * may not have run.
 */
const UNNAMED_MEMBER_NAME = "Member";

export const formerMember = (): MemberAuthorView => ({
  email: null,
  imageUrl: null,
  memberId: null,
  name: FORMER_MEMBER_NAME,
});

const toAuthorView = (member: {
  email: string;
  id: string;
  imageUrl: string | null;
  name: string | null;
}): MemberAuthorView => ({
  email: member.email || null,
  imageUrl: member.imageUrl,
  memberId: member.id,
  name: member.name || member.email || UNNAMED_MEMBER_NAME,
});

/**
 * The batched lookup behind every user-authored view: one query per request,
 * however many messages, revisions or member rows named the same people.
 *
 * The map answers for every id asked about, so callers never branch on a miss:
 * an id with no surviving membership resolves to the "Former member"
 * placeholder rather than to nothing.
 */
export const resolveMemberAuthors = async (
  db: Db,
  workspaceId: string,
  clerkUserIds: readonly string[]
): Promise<Map<string, MemberAuthorView>> => {
  const wanted = [...new Set(clerkUserIds)];
  const resolved = new Map<string, MemberAuthorView>();
  if (wanted.length === 0) {
    return resolved;
  }

  const rows = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        inArray(workspaceMembers.clerkUserId, wanted)
      )
    );

  const byClerkId = new Map(rows.map((row) => [row.clerkUserId, row]));
  for (const clerkUserId of wanted) {
    const member = byClerkId.get(clerkUserId);
    resolved.set(clerkUserId, member ? toAuthorView(member) : formerMember());
  }
  return resolved;
};
