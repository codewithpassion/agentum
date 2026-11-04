// Whether a Clerk user belongs to a Clerk organisation right now, and which
// organisations a user belongs to, asked of Clerk's Backend API. Answers are
// kept for 60 seconds per user (and organisation), in module scope so they
// outlive a request: the principal resolver is built per request and cannot
// keep them itself.
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

/**
 * `orgs`, with each user's list reused for `ttlMs`. Errors are not kept, and
 * neither is an empty list, so a user just added to an organisation is not
 * held out for a minute.
 */
export const cachedUserOrgIds = (
  orgs: UserOrgsCheck,
  { now = Date.now, ttlMs = MEMBERSHIP_TTL_MS } = {}
): UserOrgsCheck => {
  const answers = new Map<string, { expiresAt: number; orgIds: string[] }>();
  return async (userId) => {
    const current = now();
    const hit = answers.get(userId);
    if (hit && hit.expiresAt > current) {
      return [...hit.orgIds];
    }
    const orgIds = await orgs(userId);
    if (orgIds.length > 0) {
      answers.set(userId, { expiresAt: current + ttlMs, orgIds: [...orgIds] });
    } else {
      answers.delete(userId);
    }
    return orgIds;
  };
};

/** One Clerk call for all of a user's organisations, with no cache. */
const clerkOrgList = (secretKey: string): UserOrgsCheck => {
  const clerk = createClerkClient({ secretKey });
  return async (userId) => {
    const { data } = await clerk.users.getOrganizationMembershipList({
      limit: MEMBERSHIP_PAGE,
      userId,
    });
    return data.map((membership) => membership.organization.id);
  };
};

const orgLists = new Map<string, UserOrgsCheck>();

/** A user's organisations, cached for 60 seconds per user, one cache per isolate and key. */
export const clerkUserOrgIds = (secretKey: string): UserOrgsCheck => {
  let orgs = orgLists.get(secretKey);
  if (!orgs) {
    orgs = cachedUserOrgIds(clerkOrgList(secretKey));
    orgLists.set(secretKey, orgs);
  }
  return orgs;
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
