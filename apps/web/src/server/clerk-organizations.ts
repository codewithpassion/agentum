// Clerk, as the workspaces service needs it: creating and deleting organisations, and
// listing the organisations a person belongs to. Kept apart from compose.ts so that file
// stays free of Clerk imports and bun can test it.
import { createClerkClient } from "@clerk/backend";
import type {
  OrganizationsPort,
  UserOrganization,
} from "@repo/services/workspaces";

/** The parts of Clerk's organisation API the port calls. Clerk's own client fits this structurally. */
export interface OrganizationsSource {
  createOrganization: (params: {
    name: string;
    createdBy: string;
  }) => Promise<{ id: string }>;
  deleteOrganization: (organizationId: string) => Promise<unknown>;
  updateOrganization: (
    organizationId: string,
    params: { adminDeleteEnabled: boolean }
  ) => Promise<unknown>;
}

/** The part of Clerk's user API that lists a person's organisation memberships. */
export interface MembershipSource {
  getOrganizationMembershipList: (params: {
    userId: string;
    limit: number;
    offset: number;
  }) => Promise<{
    data: { organization: { id: string }; role: string }[];
    totalCount: number;
  }>;
}

/** Memberships Clerk returns per page. */
const MEMBERSHIP_PAGE = 100;

/** The organisations port: a new organisation has admin delete turned off, and a failed setup is removed. */
export const organizationsPort = (
  source: OrganizationsSource
): OrganizationsPort => ({
  create: async ({ createdBy, name }) => {
    const { id } = await source.createOrganization({ createdBy, name });
    try {
      await source.updateOrganization(id, { adminDeleteEnabled: false });
    } catch (error) {
      await source.deleteOrganization(id).catch(() => undefined);
      throw error;
    }
    return { id };
  },
  remove: async (clerkOrgId) => {
    await source.deleteOrganization(clerkOrgId);
  },
});

/** Every organisation a person belongs to, read page by page. Not cached: a change shows at once. */
export const userOrganizations = (
  source: MembershipSource
): ((userId: string) => Promise<UserOrganization[]>) => {
  // Pages in turn: each page needs the offset the one before it reached.
  const page = async (
    userId: string,
    offset: number
  ): Promise<UserOrganization[]> => {
    const { data, totalCount } = await source.getOrganizationMembershipList({
      limit: MEMBERSHIP_PAGE,
      offset,
      userId,
    });
    const organizations = data.map((membership) => ({
      clerkOrgId: membership.organization.id,
      role: membership.role,
    }));
    const next = offset + data.length;
    if (data.length < MEMBERSHIP_PAGE || next >= totalCount) {
      return organizations;
    }
    return [...organizations, ...(await page(userId, next))];
  };
  return (userId) => page(userId, 0);
};

const clients = new Map<string, ReturnType<typeof createClerkClient>>();

/** The Clerk client for a secret key, one per isolate. */
const clerkFor = (secretKey: string) => {
  let clerk = clients.get(secretKey);
  if (!clerk) {
    clerk = createClerkClient({ secretKey });
    clients.set(secretKey, clerk);
  }
  return clerk;
};

/** The organisations port backed by Clerk, for a secret key. */
export const clerkOrganizations = (secretKey: string): OrganizationsPort => {
  const clerk = clerkFor(secretKey);
  return organizationsPort({
    createOrganization: (params) =>
      clerk.organizations.createOrganization(params),
    deleteOrganization: (organizationId) =>
      clerk.organizations.deleteOrganization(organizationId),
    updateOrganization: (organizationId, params) =>
      clerk.organizations.updateOrganization(organizationId, params),
  });
};

/** The lookup of a person's organisations backed by Clerk, for a secret key. */
export const clerkUserOrganizations = (
  secretKey: string
): ((userId: string) => Promise<UserOrganization[]>) => {
  const clerk = clerkFor(secretKey);
  return userOrganizations({
    getOrganizationMembershipList: (params) =>
      clerk.users.getOrganizationMembershipList(params),
  });
};
