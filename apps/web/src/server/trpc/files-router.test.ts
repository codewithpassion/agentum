import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ORG_IDS = ["org_a", "org_b"];

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

test("a user attaches a library file and sees it described", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  await caller.library.write({
    data: "# Notes",
    encoding: "text",
    path: "notes/a.md",
  });

  const record = await caller.files.attachFromLibrary({ path: "notes/a.md" });
  expect(record).toMatchObject({ name: "a.md", source: "library" });

  const described = await caller.files.describe({ fileIds: [record.id] });
  expect(described.map((file) => file.id)).toEqual([record.id]);
});

test("another workspace cannot attach a library file", async () => {
  const owner = await callerFor({ orgId: "org_a", userId: "user_1" });
  await owner.library.write({
    data: "secret",
    encoding: "text",
    path: "plan.txt",
  });
  const other = await callerFor({ orgId: "org_b", userId: "user_2" });

  await expect(
    other.files.attachFromLibrary({ path: "plan.txt" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a run output is saved to the library at the given path", async () => {
  const composed = servicesFor();
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed
  );
  const principal = await composed.services.workspaces.sessionPrincipal({
    orgId: "org_a",
    userId: "user_1",
  });
  if (!principal) {
    throw new Error("user_1 has no workspace principal");
  }
  const uploaded = await composed.services.files.upload(principal, {
    body: new Blob(["result text"]),
    mime: "text/plain",
    name: "r.txt",
  });

  const entry = await caller.files.saveToLibrary({
    fileId: uploaded.id,
    path: "outputs/bot/r.txt",
  });
  expect(entry.path).toBe("outputs/bot/r.txt");

  const file = await caller.library.read({ path: "outputs/bot/r.txt" });
  expect(file.text).toBe("result text");
});

test("a caller without a session gets UNAUTHORIZED from both procedures", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(
    caller.files.attachFromLibrary({ path: "a.txt" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    caller.files.saveToLibrary({ fileId: "file_1", path: "a.txt" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
