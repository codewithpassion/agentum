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

const service = () => createWorkspacesService({ db });

const rowsFor = (clerkOrgId: string) =>
  db
    .select()
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, clerkOrgId))
    .all();

test("create makes the workspace once and returns the same row after", async () => {
  const svc = service();
  const first = await svc.create({ clerkOrgId: "org_a", name: "Acme" });
  const second = await svc.create({ clerkOrgId: "org_a", name: "Other" });
  expect(second).toEqual(first);
  expect(first).toMatchObject({
    clerkOrgId: "org_a",
    name: "Acme",
    timezone: "UTC",
  });
  expect(first.id).toMatch(ULID);
  expect(rowsFor("org_a")).toHaveLength(1);
});

test("forOrg returns the row an org has, and null with no row, creating nothing", async () => {
  const svc = service();
  expect(await svc.forOrg({ clerkOrgId: "org_a" })).toBeNull();
  expect(rowsFor("org_a")).toHaveLength(0);
  const made = await svc.create({ clerkOrgId: "org_a", name: "Acme" });
  expect(await svc.forOrg({ clerkOrgId: "org_a" })).toEqual(made);
  expect(await svc.forOrg({ clerkOrgId: "org_x", name: "X" })).toBeNull();
  expect(rowsFor("org_x")).toHaveLength(0);
});

test("forOrg keeps the name a row has", async () => {
  const svc = service();
  await svc.create({ clerkOrgId: "org_a", name: "Acme" });
  const later = await svc.forOrg({ clerkOrgId: "org_a", name: "Other" });
  expect(later?.name).toBe("Acme");
});

test("sessionPrincipal returns the user principal of the workspace for an org with a row", async () => {
  const svc = service();
  const workspace = await svc.create({ clerkOrgId: "org_a", name: "Acme" });
  const principal = await svc.sessionPrincipal({
    orgId: "org_a",
    userId: "user_1",
  });
  expect(principal).toMatchObject({
    kind: "user",
    userId: "user_1",
    via: "session",
  });
  expect(principal?.workspaceId).toBe(workspace.id);
});

test("sessionPrincipal marks an organisation admin and nobody else", async () => {
  const svc = service();
  await svc.create({ clerkOrgId: "org_a", name: "Acme" });
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

test("sessionPrincipal is null without an org, and for an org with no row, which stays without one", async () => {
  const svc = service();
  await svc.create({ clerkOrgId: "org_a", name: "Acme" });
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

test("concurrent creates for one org leave one row with one id", async () => {
  const svc = service();
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      svc.create({ clerkOrgId: "org_a", name: "Acme" })
    )
  );
  const ids = new Set(results.map((workspace) => workspace.id));
  expect(ids.size).toBe(1);
  expect(rowsFor("org_a")).toHaveLength(1);
});

test("firstForOrgs returns the oldest workspace among the orgs, and null for none", async () => {
  const svc = service();
  expect(await svc.firstForOrgs([])).toBeNull();
  expect(await svc.firstForOrgs(["org_a"])).toBeNull();
  const a = await svc.create({ clerkOrgId: "org_a", name: "A" });
  await svc.create({ clerkOrgId: "org_b", name: "B" });
  await db
    .update(workspaces)
    .set({ createdAt: "2020-01-01T00:00:00.000Z" })
    .where(eq(workspaces.clerkOrgId, "org_b"));
  expect((await svc.firstForOrgs(["org_a", "org_b"]))?.clerkOrgId).toBe(
    "org_b"
  );
  expect(await svc.firstForOrgs(["org_a", "org_z"])).toEqual(a);
  expect(await svc.firstForOrgs(["org_z"])).toBeNull();
});

const withNames = (
  names: Record<string, string | null>,
  calls: string[] = []
) =>
  createWorkspacesService({
    db,
    orgName: (clerkOrgId) => {
      calls.push(clerkOrgId);
      return Promise.resolve(names[clerkOrgId] ?? null);
    },
  });

test("forOrg names a row still named by its org id after the Clerk organisation", async () => {
  await service().create({ clerkOrgId: "org_a", name: "org_a" });
  const workspace = await withNames({ org_a: "Acme Pty" }).forOrg({
    clerkOrgId: "org_a",
  });
  expect(workspace?.name).toBe("Acme Pty");
});

test("forOrg leaves the org id as the name when Clerk has no name or fails", async () => {
  await service().create({ clerkOrgId: "org_a", name: "org_a" });
  expect((await withNames({}).forOrg({ clerkOrgId: "org_a" }))?.name).toBe(
    "org_a"
  );
  const failing = createWorkspacesService({
    db,
    orgName: () => Promise.reject(new Error("Clerk is down")),
  });
  expect((await failing.forOrg({ clerkOrgId: "org_a" }))?.name).toBe("org_a");
});

test("forOrg renames a row still named by its org id once Clerk has a name", async () => {
  const first = await service().create({ clerkOrgId: "org_a", name: "org_a" });
  const later = await withNames({ org_a: "Acme Pty" }).forOrg({
    clerkOrgId: "org_a",
  });
  expect(later).toEqual({
    clerkOrgId: "org_a",
    id: first.id,
    name: "Acme Pty",
    timezone: "UTC",
  });
  expect(rowsFor("org_a")).toHaveLength(1);
});

test("forOrg leaves a named workspace alone and does not call Clerk", async () => {
  const calls: string[] = [];
  const svc = withNames({ org_a: "Acme Pty" }, calls);
  await service().create({ clerkOrgId: "org_a", name: "Acme" });
  await svc.forOrg({ clerkOrgId: "org_a" });
  await svc.forOrg({ clerkOrgId: "org_a" });
  expect(calls).toEqual([]);
});
