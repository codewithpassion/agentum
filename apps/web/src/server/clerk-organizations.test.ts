import { expect, test } from "bun:test";
import {
  type MembershipSource,
  type OrganizationsSource,
  organizationsPort,
  userOrganizations,
} from "./clerk-organizations.ts";

const fakeOrganizations = (
  overrides: Partial<OrganizationsSource> = {}
): OrganizationsSource & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    createOrganization: (params) => {
      calls.push(`create:${params.name}:${params.createdBy}`);
      return Promise.resolve({ id: "org_new" });
    },
    deleteOrganization: (organizationId) => {
      calls.push(`delete:${organizationId}`);
      return Promise.resolve(undefined);
    },
    updateOrganization: (organizationId, params) => {
      calls.push(`update:${organizationId}:${params.adminDeleteEnabled}`);
      return Promise.resolve(undefined);
    },
    ...overrides,
  };
};

test("create makes the organisation, then turns admin delete off", async () => {
  const source = fakeOrganizations();
  const port = organizationsPort(source);
  expect(await port.create({ createdBy: "user_1", name: "Acme" })).toEqual({
    id: "org_new",
  });
  expect(source.calls).toEqual(["create:Acme:user_1", "update:org_new:false"]);
});

test("create deletes the organisation and rethrows when the update fails", async () => {
  const source = fakeOrganizations({
    updateOrganization: () => Promise.reject(new Error("update failed")),
  });
  const port = organizationsPort(source);
  await expect(
    port.create({ createdBy: "user_1", name: "Acme" })
  ).rejects.toThrow("update failed");
  expect(source.calls).toEqual(["create:Acme:user_1", "delete:org_new"]);
});

test("create still rethrows the update error when the cleanup delete fails", async () => {
  const port = organizationsPort({
    createOrganization: () => Promise.resolve({ id: "org_new" }),
    deleteOrganization: () => Promise.reject(new Error("delete failed")),
    updateOrganization: () => Promise.reject(new Error("update failed")),
  });
  await expect(
    port.create({ createdBy: "user_1", name: "Acme" })
  ).rejects.toThrow("update failed");
});

test("remove deletes the organisation", async () => {
  const source = fakeOrganizations();
  await organizationsPort(source).remove("org_old");
  expect(source.calls).toEqual(["delete:org_old"]);
});

const memberships = (
  count: number
): { organization: { id: string }; role: string }[] =>
  Array.from({ length: count }, (_, index) => ({
    organization: { id: `org_${index}` },
    role: index === 0 ? "org:admin" : "org:member",
  }));

test("userOrganizations maps role and organisation id, and pages across two pages", async () => {
  const all = memberships(150);
  const offsets: number[] = [];
  const source: MembershipSource = {
    getOrganizationMembershipList: ({ limit, offset, userId }) => {
      expect(userId).toBe("user_1");
      expect(limit).toBe(100);
      offsets.push(offset);
      return Promise.resolve({
        data: all.slice(offset, offset + limit),
        totalCount: all.length,
      });
    },
  };
  const orgs = await userOrganizations(source)("user_1");
  expect(offsets).toEqual([0, 100]);
  expect(orgs).toHaveLength(150);
  expect(orgs[0]).toEqual({ clerkOrgId: "org_0", role: "org:admin" });
  expect(orgs[149]).toEqual({ clerkOrgId: "org_149", role: "org:member" });
});

test("userOrganizations answers an empty list for a person with no memberships", async () => {
  const orgs = await userOrganizations({
    getOrganizationMembershipList: () =>
      Promise.resolve({ data: [], totalCount: 0 }),
  })("user_1");
  expect(orgs).toEqual([]);
});
