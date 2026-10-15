import { beforeEach, expect, test } from "bun:test";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { buildContext, parseOrgIds } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ALLOWED_ORG_IDS = ["org_a"];

let db: ReturnType<typeof migrated>;

beforeEach(() => {
  db = migrated();
});

const callerFor = async (session: {
  orgId?: string | null;
  userId: string | null;
}) =>
  appRouter.createCaller(
    await buildContext({ allowedOrgIds: ALLOWED_ORG_IDS, db, session })
  );

const workspaceRows = (clerkOrgId: string) =>
  db
    .select()
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, clerkOrgId))
    .all();

test("me returns the user and the workspace row for the active org", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  const me = await caller.me();
  const [row] = workspaceRows("org_a");
  if (!row) {
    throw new Error("me did not create a workspace row for org_a");
  }
  expect(me).toEqual({ userId: "user_1", workspaceId: row.id });
});

test("calling me again keeps one workspace row", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const first = await caller.me();
  const second = await caller.me();
  expect(second).toEqual(first);
  expect(workspaceRows("org_a")).toHaveLength(1);
});

test("signed out, no org, and a disallowed org are all 401", async () => {
  await expect(
    (await callerFor({ orgId: "org_a", userId: null })).me()
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

  await expect(
    (await callerFor({ orgId: null, userId: "user_1" })).me()
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

  await expect(
    (await callerFor({ orgId: "org_b", userId: "user_1" })).me()
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(workspaceRows("org_b")).toHaveLength(0);
});

test("parseOrgIds splits, trims and drops empty entries", () => {
  expect(parseOrgIds(undefined)).toEqual([]);
  expect(parseOrgIds("")).toEqual([]);
  expect(parseOrgIds("   ")).toEqual([]);
  expect(parseOrgIds("org_a")).toEqual(["org_a"]);
  expect(parseOrgIds(" org_a , org_b ")).toEqual(["org_a", "org_b"]);
  expect(parseOrgIds("org_a,")).toEqual(["org_a"]);
  expect(parseOrgIds(",org_a,,org_b,")).toEqual(["org_a", "org_b"]);
});
