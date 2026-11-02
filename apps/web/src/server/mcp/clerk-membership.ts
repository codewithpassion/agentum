// Whether a Clerk user belongs to a Clerk organisation right now, asked of
// Clerk's Backend API. Answers are kept for 60 seconds per user and
// organisation, in module scope so they outlive a request: the principal
// resolver is built per request and cannot keep them itself.
import { createClerkClient } from "@clerk/backend";

/** Memberships Clerk returns per page; far more than one person has. */
const MEMBERSHIP_PAGE = 100;
const MEMBERSHIP_TTL_MS = 60_000;

export type OrgMemberCheck = (
  userId: string,
  clerkOrgId: string
) => Promise<boolean>;

/** The ids of the organisations a Clerk user belongs to right now. */
export type UserOrgsCheck = (userId: string) => Promise<string[]>;

/** `check`, with each answer reused for `ttlMs`. Errors are not kept. */
export const cachedOrgMemberCheck = (
  check: OrgMemberCheck,
  { now = Date.now, ttlMs = MEMBERSHIP_TTL_MS } = {}
): OrgMemberCheck => {
  const answers = new Map<string, { expiresAt: number; member: boolean }>();
  return async (userId, clerkOrgId) => {
    const key = `${userId}\n${clerkOrgId}`;
    const current = now();
    const hit = answers.get(key);
    if (hit && hit.expiresAt > current) {
      return hit.member;
    }
    const member = await check(userId, clerkOrgId);
    answers.set(key, { expiresAt: current + ttlMs, member });
    return member;
  };
};

/** One Clerk call for all of a user's organisations, with no cache. */
export const clerkUserOrgIds = (secretKey: string): UserOrgsCheck => {
  const clerk = createClerkClient({ secretKey });
  return async (userId) => {
    const { data } = await clerk.users.getOrganizationMembershipList({
      limit: MEMBERSHIP_PAGE,
      userId,
    });
    return data.map((membership) => membership.organization.id);
  };
};

const clerkCheck = (secretKey: string): OrgMemberCheck => {
  const clerk = createClerkClient({ secretKey });
  return async (userId, clerkOrgId) => {
    const { data } = await clerk.users.getOrganizationMembershipList({
      limit: MEMBERSHIP_PAGE,
      userId,
    });
    return data.some((membership) => membership.organization.id === clerkOrgId);
  };
};

/** The membership check with no cache, for callers that must see a removal at once. */
export const clerkOrgMemberCheckFresh = (secretKey: string): OrgMemberCheck =>
  clerkCheck(secretKey);

const checks = new Map<string, OrgMemberCheck>();

/** The cached membership check for a Clerk secret key, one per isolate. */
export const clerkOrgMemberCheck = (secretKey: string): OrgMemberCheck => {
  let check = checks.get(secretKey);
  if (!check) {
    check = cachedOrgMemberCheck(clerkCheck(secretKey));
    checks.set(secretKey, check);
  }
  return check;
};
