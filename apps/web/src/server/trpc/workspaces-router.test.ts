import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

let db: ReturnType<typeof migrated>;
let made: { createdBy: string; name: string }[];
let invited: { clerkOrgId: string; redirectUrl: string; role: string }[];

beforeEach(() => {
  db = migrated(["org_a"]);
  made = [];
  invited = [];
});

const infra = (): Infra => {
  const store = new Map<string, string>();
  return {
    atomic: sqliteAtomic(db),
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    clock: systemClock,
    devFakeRuntime: true,
    fileBlobs: memoryFileBlobs(),
    organizations: {
      create: (input) => {
        made.push(input);
        return Promise.resolve({ id: `org_new_${made.length}` });
      },
      invite: ({ clerkOrgId, redirectUrl, role }) => {
        invited.push({ clerkOrgId, redirectUrl, role });
        return Promise.resolve("invited");
      },
      remove: () => Promise.resolve(),
    },
    publicBaseUrl: "https://app.test",
    relay: noopRelay,
    userOrganizations: () =>
      Promise.resolve([
        { clerkOrgId: "org_a", role: "org:admin" },
        { clerkOrgId: "org_other_app", role: "org:member" },
      ]),
  };
};

const callerFor = async (session: {
  orgId?: string | null;
  orgRole?: string | null;
  userId: string | null;
}) => {
  const composed: Composed = composeWith({ db, infra: infra() });
  return appRouter.createCaller(await buildContext({ composed, session }));
};

test("mine answers a signed-in person with no active organisation, leaving out orgs with no row", async () => {
  const caller = await callerFor({ userId: "user_1" });
  const mine = await caller.workspaces.mine();
  expect(mine.map((entry) => [entry.clerkOrgId, entry.role])).toEqual([
    ["org_a", "org:admin"],
  ]);
});

test("mine answers 401 when signed out", async () => {
  const caller = await callerFor({ userId: null });
  await expect(caller.workspaces.mine()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("create makes a workspace for an admin and returns its org id", async () => {
  const caller = await callerFor({
    orgId: "org_a",
    orgRole: "org:admin",
    userId: "user_1",
  });
  expect(await caller.workspaces.create({ name: " Fresh " })).toEqual({
    clerkOrgId: "org_new_1",
  });
  expect(made).toEqual([{ createdBy: "user_1", name: "Fresh" }]);
});

test("create answers FORBIDDEN to a non-admin and BAD_REQUEST to a blank name", async () => {
  const member = await callerFor({
    orgId: "org_a",
    orgRole: "org:member",
    userId: "user_2",
  });
  await expect(member.workspaces.create({ name: "X" })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  const admin = await callerFor({
    orgId: "org_a",
    orgRole: "org:admin",
    userId: "user_1",
  });
  await expect(admin.workspaces.create({ name: "  " })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  expect(made).toEqual([]);
});

test("invite emails an invitation from the caller's workspace, for an admin only", async () => {
  const admin = await callerFor({
    orgId: "org_a",
    orgRole: "org:admin",
    userId: "user_1",
  });
  expect(
    await admin.workspaces.invite({
      email: "new@example.com",
      role: "org:member",
    })
  ).toEqual({ email: "new@example.com" });
  expect(invited).toEqual([
    {
      clerkOrgId: "org_a",
      redirectUrl: "https://app.test/accept-invitation?org=org_a",
      role: "org:member",
    },
  ]);
  const member = await callerFor({
    orgId: "org_a",
    orgRole: "org:member",
    userId: "user_2",
  });
  await expect(
    member.workspaces.invite({ email: "new@example.com", role: "org:member" })
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    admin.workspaces.invite({ email: "nope", role: "org:member" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(invited).toHaveLength(1);
});
