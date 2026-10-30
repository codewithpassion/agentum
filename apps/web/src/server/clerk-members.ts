// Clerk, as the members port needs it: everyone in a workspace's organisation.
// Kept apart from compose.ts so that file stays free of Clerk imports and bun can test it.
import { createClerkClient } from "@clerk/backend";
import type { WorkspaceMember } from "@repo/db/shared";
import type { MemberLister } from "@repo/services/members";

/** The parts of a Clerk organisation membership the rail reads. A Clerk `OrganizationMembership` fits this structurally. */
export interface ClerkMembershipSource {
  publicUserData?: {
    firstName: string | null;
    identifier: string;
    lastName: string | null;
    userId: string;
  } | null;
}

/** Memberships Clerk returns per page. */
const MEMBERSHIP_PAGE = 100;
const MEMBER_TTL_MS = 60_000;

/** A member's "First Last" name, or the identifier (email or username) when there is no name. */
export const toWorkspaceMember = (
  membership: ClerkMembershipSource
): WorkspaceMember | null => {
  const data = membership.publicUserData;
  if (!data) {
    return null;
  }
  const name = [data.firstName, data.lastName]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join(" ");
  return {
    name: name.length > 0 ? name : data.identifier,
    userId: data.userId,
  };
};

/** `list`, with each organisation's answer reused for `ttlMs`. Errors are not kept. */
export const cachedMembers = (
  list: MemberLister,
  { now = Date.now, ttlMs = MEMBER_TTL_MS } = {}
): MemberLister => {
  const answers = new Map<
    string,
    { expiresAt: number; members: WorkspaceMember[] }
  >();
  return async (clerkOrgId) => {
    const current = now();
    const hit = answers.get(clerkOrgId);
    if (hit && hit.expiresAt > current) {
      return hit.members;
    }
    const members = await list(clerkOrgId);
    answers.set(clerkOrgId, { expiresAt: current + ttlMs, members });
    return members;
  };
};

const clerkList = (secretKey: string): MemberLister => {
  const clerk = createClerkClient({ secretKey });
  // Pages in turn: each page needs the offset the one before it reached.
  const page = async (
    clerkOrgId: string,
    offset: number
  ): Promise<WorkspaceMember[]> => {
    const { data, totalCount } =
      await clerk.organizations.getOrganizationMembershipList({
        limit: MEMBERSHIP_PAGE,
        offset,
        organizationId: clerkOrgId,
      });
    const members = data
      .map(toWorkspaceMember)
      .filter((member): member is WorkspaceMember => member !== null);
    const next = offset + data.length;
    if (data.length < MEMBERSHIP_PAGE || next >= totalCount) {
      return members;
    }
    return [...members, ...(await page(clerkOrgId, next))];
  };
  return (clerkOrgId) => page(clerkOrgId, 0);
};

const listers = new Map<string, MemberLister>();

/** The cached Clerk member lister for a secret key, one per isolate. */
export const clerkMembers = (secretKey: string): MemberLister => {
  let list = listers.get(secretKey);
  if (!list) {
    list = cachedMembers(clerkList(secretKey));
    listers.set(secretKey, list);
  }
  return list;
};
