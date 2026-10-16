// Whether a Clerk user belongs to a Clerk organisation right now, asked of
// Clerk's Backend API. The principal resolver caches the answer for 60 seconds.
import { createClerkClient } from "@clerk/backend";

/** Memberships Clerk returns per page; far more than one person has. */
const MEMBERSHIP_PAGE = 100;

export type OrgMemberCheck = (
  userId: string,
  clerkOrgId: string
) => Promise<boolean>;

export const clerkOrgMemberCheck = (secretKey: string): OrgMemberCheck => {
  const clerk = createClerkClient({ secretKey });
  return async (userId, clerkOrgId) => {
    const { data } = await clerk.users.getOrganizationMembershipList({
      limit: MEMBERSHIP_PAGE,
      userId,
    });
    return data.some((membership) => membership.organization.id === clerkOrgId);
  };
};
