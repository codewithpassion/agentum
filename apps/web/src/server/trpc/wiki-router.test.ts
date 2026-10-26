import { expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { composeWith } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

test("wiki procedures create, list and read pages through composition", async () => {
  const db = migrated();
  const composed = composeWith({ db, allowedOrgIds: ["org"], infra: {
    atomic: sqliteAtomic(db), blobs: { get: async () => null, put: async () => undefined }, clock: systemClock, devFakeRuntime: true, fileBlobs: memoryFileBlobs(), relay: noopRelay,
  } });
  const caller = appRouter.createCaller(await buildContext({ composed, session: { orgId: "org", userId: "user" } }));
  const created = await caller.wiki.createPage({ title: "Welcome" });
  expect(created.path).toBe("wiki/welcome.md");
  expect((await caller.wiki.pages())[0]?.title).toBe("Welcome");
  expect((await caller.wiki.page({ path: created.path })).body).toBe("# Welcome\n");
  const anonymous = appRouter.createCaller(await buildContext({ composed, session: { userId: null } }));
  await expect(anonymous.wiki.pages()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
