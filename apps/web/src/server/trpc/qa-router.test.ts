import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ALLOWED_ORG_IDS = ["org_a", "org_b"];

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
    fileBlobs: memoryFileBlobs(),
    relay: noopRelay,
  };
};

const servicesFor = (): Composed =>
  composeWith({ allowedOrgIds: ALLOWED_ORG_IDS, db, infra: infra() });

const callerFor = async (
  session: { orgId?: string | null; userId: string | null },
  composed: Composed = servicesFor()
) => appRouter.createCaller(await buildContext({ composed, session }));

test("Q&A router delegates the complete board lifecycle", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const question = await caller.qa.ask({
    body: "Which harbour?",
    title: "Where?",
  });
  const answer = await caller.qa.answer({
    body: "Sydney",
    questionId: question.id,
  });
  expect((await caller.qa.get({ questionId: question.id })).answers).toEqual([
    answer,
  ]);
  expect(
    (await caller.qa.list({ author: "user_1", status: "open" })).questions
  ).toHaveLength(1);
  expect(await caller.qa.openCount()).toBe(1);
  expect(
    await caller.qa.accept({ answerId: answer.id, questionId: question.id })
  ).toMatchObject({ status: "answered" });
  expect(await caller.qa.openCount()).toBe(0);
  expect(await caller.qa.close({ questionId: question.id })).toMatchObject({
    status: "closed",
  });
});

test("router isolates workspaces and requires a session", async () => {
  const owner = await callerFor({ orgId: "org_a", userId: "user_1" });
  const question = await owner.qa.ask({ body: "Question", title: "Private" });
  const other = await callerFor({ orgId: "org_b", userId: "user_2" });
  expect((await other.qa.list({})).questions).toEqual([]);
  await expect(other.qa.get({ questionId: question.id })).rejects.toMatchObject(
    { code: "NOT_FOUND" }
  );
  const anonymous = await callerFor({ userId: null });
  await expect(anonymous.qa.list({})).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    owner.qa.ask({ body: "invalid", title: "" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});
