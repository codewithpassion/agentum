import { beforeEach, expect, test } from "bun:test";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { createWorkspacesService } from "./workspaces.ts";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let db: ReturnType<typeof migrated>;

beforeEach(() => {
  db = migrated();
});

const service = () => createWorkspacesService({ allowedOrgIds: ["org_a"], db });

const rowsFor = (clerkOrgId: string) =>
  db
    .select()
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, clerkOrgId))
    .all();

test("forOrg creates the workspace once and returns the same row after", async () => {
  const svc = service();
  const first = await svc.forOrg({ clerkOrgId: "org_a" });
  const second = await svc.forOrg({ clerkOrgId: "org_a" });
  expect(second).toEqual(first);
  expect(first).toMatchObject({
    clerkOrgId: "org_a",
    name: "org_a",
    timezone: "UTC",
  });
  expect(first?.id).toMatch(ULID);
  expect(rowsFor("org_a")).toHaveLength(1);
});

test("forOrg names a new workspace after the given name and keeps that name", async () => {
  const svc = service();
  await svc.forOrg({ clerkOrgId: "org_a", name: "Acme" });
  const later = await svc.forOrg({ clerkOrgId: "org_a", name: "Other" });
  expect(later?.name).toBe("Acme");
  expect(rowsFor("org_a")).toHaveLength(1);
});

test("forOrg returns null and creates nothing for an org that is not allowed", async () => {
  expect(await service().forOrg({ clerkOrgId: "org_x" })).toBeNull();
  expect(rowsFor("org_x")).toHaveLength(0);
});

test("sessionPrincipal returns the user principal of the workspace for an allowed org", async () => {
  const svc = service();
  const workspace = await svc.forOrg({ clerkOrgId: "org_a" });
  const principal = await svc.sessionPrincipal({
    orgId: "org_a",
    userId: "user_1",
  });
  expect(principal).toMatchObject({
    kind: "user",
    userId: "user_1",
    via: "session",
  });
  expect(principal?.workspaceId).toBe(workspace?.id);
});

test("sessionPrincipal marks an organisation admin and nobody else", async () => {
  const svc = service();
  const roles = ["org:admin", "org:member", null, undefined];
  const flags = await Promise.all(
    roles.map(async (orgRole) => {
      const principal = await svc.sessionPrincipal({
        orgId: "org_a",
        orgRole,
        userId: "u",
      });
      return principal?.kind === "user" ? principal.isAdmin : undefined;
    })
  );
  expect(flags).toEqual([true, false, false, false]);
});

test("sessionPrincipal is null without an org or for an org that is not allowed", async () => {
  const svc = service();
  expect(
    await svc.sessionPrincipal({ orgId: null, userId: "user_1" })
  ).toBeNull();
  expect(
    await svc.sessionPrincipal({ orgId: undefined, userId: "user_1" })
  ).toBeNull();
  expect(
    await svc.sessionPrincipal({ orgId: "org_x", userId: "user_1" })
  ).toBeNull();
  expect(rowsFor("org_x")).toHaveLength(0);
});

test("concurrent first calls for one org leave one row with one id", async () => {
  const svc = service();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => svc.forOrg({ clerkOrgId: "org_a" }))
  );
  const ids = new Set(results.map((workspace) => workspace?.id));
  expect(ids.size).toBe(1);
  expect(rowsFor("org_a")).toHaveLength(1);
});
