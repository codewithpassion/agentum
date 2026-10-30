import { beforeEach, expect, test } from "bun:test";
import { workspaces } from "@repo/db/schema/workspaces";
import type { WorkspaceMember } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import { createMembersService, type MemberLister } from "./members.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const NOW = "2026-01-01T00:00:00.000Z";
const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const otherUser: Principal = {
  kind: "user",
  userId: "u2",
  via: "session",
  workspaceId: OTHER_WORKSPACE,
};

let db: ReturnType<typeof migrated>;
let calls: string[];

const seedWorkspace = (id: string, clerkOrgId: string) =>
  db
    .insert(workspaces)
    .values({
      clerkOrgId,
      createdAt: NOW,
      id,
      name: id,
      timezone: "UTC",
    })
    .run();

/** Records each organisation it is asked about and answers with `members`. */
const recordingLister =
  (members: WorkspaceMember[]): MemberLister =>
  (clerkOrgId) => {
    calls.push(clerkOrgId);
    return Promise.resolve(members);
  };

beforeEach(() => {
  db = migrated();
  seedWorkspace(WORKSPACE, "org_known");
  seedWorkspace(OTHER_WORKSPACE, "org_other");
  calls = [];
});

test("list returns the lister's members sorted by name, then user id", async () => {
  const members = createMembersService({
    db,
    lister: recordingLister([
      { name: "Cy", userId: "u3" },
      { name: "Ann", userId: "u9" },
      { name: "Ben", userId: "u2" },
      { name: "Ann", userId: "u1" },
    ]),
  });
  expect(await members.list(user)).toEqual([
    { name: "Ann", userId: "u1" },
    { name: "Ann", userId: "u9" },
    { name: "Ben", userId: "u2" },
    { name: "Cy", userId: "u3" },
  ]);
});

test("list asks the lister for the workspace's Clerk organisation", async () => {
  const members = createMembersService({
    db,
    lister: recordingLister([]),
  });
  await members.list(user);
  expect(calls).toEqual(["org_known"]);
});

test("a user of another workspace gets that workspace's members only", async () => {
  const members = createMembersService({
    db,
    lister: recordingLister([{ name: "Dee", userId: "u2" }]),
  });
  expect(await members.list(otherUser)).toEqual([
    { name: "Dee", userId: "u2" },
  ]);
  expect(calls).toEqual(["org_other"]);
});

test("a non-user principal is refused before the lister runs", async () => {
  const members = createMembersService({
    db,
    lister: recordingLister([]),
  });
  const machine: Principal = {
    kind: "machine",
    machineId: "m1",
    workspaceId: WORKSPACE,
  };
  await expect(members.list(machine)).rejects.toBeInstanceOf(ForbiddenError);
  expect(calls).toEqual([]);
});

test("without a lister, list throws an invalid error", async () => {
  const members = createMembersService({ db });
  const failure = await members.list(user).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ServiceError);
  expect(failure).toMatchObject({ code: "invalid" });
});

test("a lister that throws makes list throw", async () => {
  const members = createMembersService({
    db,
    lister: () => Promise.reject(new Error("Clerk is down")),
  });
  await expect(members.list(user)).rejects.toThrow("Clerk is down");
});
