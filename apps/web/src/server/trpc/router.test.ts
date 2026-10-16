import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { runs } from "@repo/db/schema/runs";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { eq } from "drizzle-orm";
import { composeWith, type Infra, parseOrgIds } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ALLOWED_ORG_IDS = ["org_a"];

let db: ReturnType<typeof migrated>;

beforeEach(() => {
  db = migrated();
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
    relay: noopRelay,
  };
};

const callerFor = async (session: {
  orgId?: string | null;
  userId: string | null;
}) =>
  appRouter.createCaller(
    await buildContext({
      composed: composeWith({
        allowedOrgIds: ALLOWED_ORG_IDS,
        db,
        infra: infra(),
      }),
      session,
    })
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

const agentInput = {
  model: "fake",
  name: "Fake echo",
  runtime: "fake",
} as const;

test("agents.create then runs.start runs the echo end to end", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);
  expect(await caller.agents.list({})).toEqual([agent]);

  const started = await caller.runs.start({
    agentId: agent.id,
    input: { text: "hi" },
    session: { origin: "ui" },
  });
  const run = await caller.runs.get({ runId: started.runId });
  expect(run.status).toBe("done");
  expect(run.resultText).toBe("Echo: hi");
  const [row] = db.select().from(runs).all();
  expect(row?.onBehalfOfUserId).toBe("user_1");
});

test("service errors keep their meaning over tRPC", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);

  await expect(caller.agents.create(agentInput)).rejects.toMatchObject({
    code: "CONFLICT",
  });
  await expect(caller.agents.get({ id: "missing" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(
    caller.runs.start({
      agentId: agent.id,
      input: { fileIds: ["nope"], text: "hi" },
      session: { origin: "ui" },
    })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    caller.runs.start({
      agentId: agent.id,
      input: { text: "" },
      session: { origin: "ui" },
    })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});
