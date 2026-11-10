import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ORG_IDS = ["org_a"];

let db: ReturnType<typeof migrated>;

beforeEach(() => {
  db = migrated(ORG_IDS);
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
    relay: noopRelay,
  };
};

const servicesFor = (): Composed => composeWith({ db, infra: infra() });

const callerFor = async (
  session: { orgId?: string | null; userId: string | null },
  composed: Composed = servicesFor()
) => appRouter.createCaller(await buildContext({ composed, session }));

test("a caller without a session gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(
    caller.agentProfile.profile({ agentId: "a" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    caller.agentProfile.askBefore({ agentId: "a" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    caller.agentProfile.setAskBefore({ action: "x", agentId: "a", ask: true })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("a signed-in caller reads a seeded agent and round-trips ask-before", async () => {
  const composed = servicesFor();
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed
  );
  const { workspaceId } = await caller.me();
  const agent = await composed.services.agents.create(
    { kind: "user", userId: "user_1", via: "session", workspaceId },
    { model: "fake", name: "Pelican", runtime: "fake" }
  );

  const profile = await caller.agentProfile.profile({ agentId: agent.id });
  expect(profile.header).toMatchObject({ id: agent.id, name: "Pelican" });

  const [action] = await caller.agentProfile.askBefore({ agentId: agent.id });
  expect(action).toBeDefined();
  const isAsking = async () =>
    (await caller.agentProfile.askBefore({ agentId: agent.id })).find(
      (row) => row.action === action?.action
    )?.ask;

  expect(await isAsking()).toBe(false);
  await caller.agentProfile.setAskBefore({
    action: action?.action ?? "",
    agentId: agent.id,
    ask: true,
  });
  expect(await isAsking()).toBe(true);
  await caller.agentProfile.setAskBefore({
    action: action?.action ?? "",
    agentId: agent.id,
    ask: false,
  });
  expect(await isAsking()).toBe(false);

  expect(await caller.agentProfile.askLevel({ agentId: agent.id })).toBe(
    "rarely"
  );
  await caller.agentProfile.setAskLevel({
    agentId: agent.id,
    level: "everything",
  });
  expect(await caller.agentProfile.askLevel({ agentId: agent.id })).toBe(
    "everything"
  );
  expect(await isAsking()).toBe(true);
  await expect(
    caller.agentProfile.setAskBefore({
      action: "not-an-action",
      agentId: agent.id,
      ask: true,
    })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});
