import { beforeEach, expect, test } from "bun:test";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import {
  createWorkspacesService,
  MAX_WORKSPACE_NAME_LENGTH,
  type OrganizationsPort,
  type Principal,
  SYSTEM_PRINCIPAL,
} from "./workspaces.ts";

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

// createFromSession and mine

const adminSession = {
  isAdmin: true,
  kind: "user" as const,
  userId: "user_1",
  via: "session" as const,
  workspaceId: "w",
};

type InviteInput = Parameters<OrganizationsPort["invite"]>[0];

const fakeOrganizations = (
  inviteResult: Awaited<ReturnType<OrganizationsPort["invite"]>> = "invited"
) => {
  const state = {
    invited: [] as InviteInput[],
    made: [] as { createdBy: string; name: string }[],
    removed: [] as string[],
  };
  return {
    port: {
      create: (input: { createdBy: string; name: string }) => {
        state.made.push(input);
        return Promise.resolve({ id: `org_new_${state.made.length}` });
      },
      invite: (input: InviteInput) => {
        state.invited.push(input);
        return Promise.resolve(inviteResult);
      },
      remove: (id: string) => {
        state.removed.push(id);
        return Promise.resolve();
      },
    },
    state,
  };
};

test("createFromSession lets an admin make an organisation and its row", async () => {
  const { port, state } = fakeOrganizations();
  const svc = createWorkspacesService({ db, organizations: port });
  const made = await svc.createFromSession(adminSession, { name: "  Fresh  " });
  expect(made).toMatchObject({ clerkOrgId: "org_new_1", name: "Fresh" });
  expect(state.made).toEqual([{ createdBy: "user_1", name: "Fresh" }]);
  expect(rowsFor("org_new_1")).toHaveLength(1);
});

test("createFromSession refuses a non-admin and every non-session principal", async () => {
  const { port, state } = fakeOrganizations();
  const svc = createWorkspacesService({ db, organizations: port });
  const refused: Principal[] = [
    { ...adminSession, isAdmin: false },
    { ...adminSession, isAdmin: undefined },
    { ...adminSession, via: "api_key" },
    { ...adminSession, via: "oauth" },
    { ...adminSession, via: "slack" },
    { agentId: "a", kind: "run", runId: "r", workspaceId: "w" },
    { kind: "machine", machineId: "m", workspaceId: "w" },
    { agentId: "a", kind: "trigger", triggerId: "t", workspaceId: "w" },
    { agentId: "a", connectionId: "c", kind: "peer", workspaceId: "w" },
    SYSTEM_PRINCIPAL,
  ];
  await Promise.all(
    refused.map((principal) =>
      expect(
        svc.createFromSession(principal, { name: "Fresh" })
      ).rejects.toBeInstanceOf(ForbiddenError)
    )
  );
  expect(state.made).toEqual([]);
});

test("createFromSession refuses a blank or oversized name before touching Clerk", async () => {
  const { port, state } = fakeOrganizations();
  const svc = createWorkspacesService({ db, organizations: port });
  await Promise.all(
    ["", "   ", "x".repeat(MAX_WORKSPACE_NAME_LENGTH + 1)].map((name) =>
      expect(
        svc.createFromSession(adminSession, { name })
      ).rejects.toBeInstanceOf(ServiceError)
    )
  );
  await svc.createFromSession(adminSession, {
    name: "x".repeat(MAX_WORKSPACE_NAME_LENGTH),
  });
  expect(state.made).toHaveLength(1);
});

test("createFromSession deletes the organisation when the row fails", async () => {
  const { port, state } = fakeOrganizations();
  const failing = new Proxy(db, {
    get: (target, prop, receiver) =>
      prop === "insert"
        ? () => {
            throw new Error("insert failed");
          }
        : Reflect.get(target, prop, receiver),
  });
  const svc = createWorkspacesService({ db: failing, organizations: port });
  await expect(
    svc.createFromSession(adminSession, { name: "Fresh" })
  ).rejects.toThrow("insert failed");
  expect(state.removed).toEqual(["org_new_1"]);
});

test("mine lists the memberships that have a row with their role, and leaves the rest out", async () => {
  const svc = createWorkspacesService({
    db,
    userOrganizations: (userId) =>
      Promise.resolve(
        userId === "user_1"
          ? [
              { clerkOrgId: "org_a", role: "org:admin" },
              { clerkOrgId: "org_b", role: "org:member" },
              { clerkOrgId: "org_norow", role: "org:admin" },
            ]
          : []
      ),
  });
  const a = await svc.create({ clerkOrgId: "org_a", name: "A" });
  await svc.create({ clerkOrgId: "org_b", name: "B" });
  await svc.create({ clerkOrgId: "org_theirs", name: "Theirs" });
  const mine = await svc.mine("user_1");
  expect(
    mine
      .map((entry) => [entry.clerkOrgId, entry.role])
      .sort((x, y) => String(x[0]).localeCompare(String(y[0])))
  ).toEqual([
    ["org_a", "org:admin"],
    ["org_b", "org:member"],
  ]);
  expect(mine.find((entry) => entry.clerkOrgId === "org_a")?.workspaceId).toBe(
    a.id
  );
  expect(await svc.mine("user_2")).toEqual([]);
});

// inviteFromSession

const BASE_URL = "https://app.test";

const inviteService = async (
  inviteResult?: Awaited<ReturnType<OrganizationsPort["invite"]>>
) => {
  const { port, state } = fakeOrganizations(inviteResult);
  const svc = createWorkspacesService({
    db,
    organizations: port,
    publicBaseUrl: BASE_URL,
  });
  const workspace = await svc.create({ clerkOrgId: "org_a", name: "A" });
  const principal = { ...adminSession, workspaceId: workspace.id };
  return { principal, state, svc };
};

test("inviteFromSession sends the principal's organisation, the caller and the redirect URL", async () => {
  const { principal, state, svc } = await inviteService();
  expect(
    await svc.inviteFromSession(principal, {
      email: "  New@Example.com ",
      role: "org:admin",
    })
  ).toEqual({ email: "New@Example.com" });
  expect(state.invited).toEqual([
    {
      clerkOrgId: "org_a",
      emailAddress: "New@Example.com",
      inviterUserId: "user_1",
      redirectUrl: `${BASE_URL}/accept-invitation?org=org_a`,
      role: "org:admin",
    },
  ]);
});

test("inviteFromSession refuses a non-admin and every non-session principal", async () => {
  const { principal, state, svc } = await inviteService();
  const refused: Principal[] = [
    { ...principal, isAdmin: false },
    { ...principal, isAdmin: undefined },
    { ...principal, via: "api_key" },
    { ...principal, via: "oauth" },
    { ...principal, via: "slack" },
    { agentId: "a", kind: "run", runId: "r", workspaceId: "w" },
    { kind: "machine", machineId: "m", workspaceId: "w" },
    { agentId: "a", kind: "trigger", triggerId: "t", workspaceId: "w" },
    { agentId: "a", connectionId: "c", kind: "peer", workspaceId: "w" },
    SYSTEM_PRINCIPAL,
  ];
  await Promise.all(
    refused.map((who) =>
      expect(
        svc.inviteFromSession(who, { email: "a@b.co", role: "org:member" })
      ).rejects.toBeInstanceOf(ForbiddenError)
    )
  );
  expect(state.invited).toEqual([]);
});

test("inviteFromSession refuses a bad email or role before touching Clerk", async () => {
  const { principal, state, svc } = await inviteService();
  await Promise.all(
    ["", "   ", "nope", "a@", "@b.co", "a b@c.co"].map((email) =>
      expect(
        svc.inviteFromSession(principal, { email, role: "org:member" })
      ).rejects.toBeInstanceOf(ServiceError)
    )
  );
  await expect(
    svc.inviteFromSession(principal, {
      email: "a@b.co",
      role: "org:owner" as "org:admin",
    })
  ).rejects.toBeInstanceOf(ServiceError);
  expect(state.invited).toEqual([]);
});

test("inviteFromSession explains each Clerk conflict", async () => {
  const member = await inviteService("already_member");
  await expect(
    member.svc.inviteFromSession(member.principal, {
      email: "a@b.co",
      role: "org:member",
    })
  ).rejects.toMatchObject({
    code: "conflict",
    message: "a@b.co is already a member of this workspace.",
  });
  const invited = await inviteService("already_invited");
  await expect(
    invited.svc.inviteFromSession(invited.principal, {
      email: "a@b.co",
      role: "org:member",
    })
  ).rejects.toMatchObject({
    code: "conflict",
    message: "a@b.co already has a pending invitation.",
  });
});

test("inviteFromSession says so when the deployment has no base URL", async () => {
  const { port, state } = fakeOrganizations();
  const svc = createWorkspacesService({ db, organizations: port });
  const workspace = await svc.create({ clerkOrgId: "org_a", name: "A" });
  await expect(
    svc.inviteFromSession(
      { ...adminSession, workspaceId: workspace.id },
      { email: "a@b.co", role: "org:member" }
    )
  ).rejects.toMatchObject({
    message: "Invitations are not set up on this deployment.",
  });
  expect(state.invited).toEqual([]);
});
