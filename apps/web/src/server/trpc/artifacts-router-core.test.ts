import { expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createArtifactsService } from "@repo/services/artifacts/service";
import { createEventsService } from "@repo/services/events";
import { createLibraryService } from "@repo/services/library";
import { memoryLibraryBlobs } from "@repo/services/library/memory";
import { systemClock } from "@repo/services/runs/types";
import type { Context } from "./context.ts";
import { appRouter } from "./router.ts";

const user = (userId: string) =>
  ({ kind: "user", userId, via: "session", workspaceId: "w1" }) as const;
const u1 = user("u1");
const u2 = user("u2");

const setup = () => {
  const db = migrated();
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w1",
      createdAt: new Date().toISOString(),
      id: "w1",
      name: "W1",
      timezone: "UTC",
    })
    .run();
  const atomic = sqliteAtomic(db);
  const events = createEventsService({
    blobs: { get: async () => null, put: async () => undefined },
    db,
  });
  const service = createArtifactsService({
    atomic,
    blobs: memoryLibraryBlobs(),
    clock: systemClock,
    db,
    events,
    library: createLibraryService({
      atomic,
      blobs: memoryLibraryBlobs(),
      clock: systemClock,
      db,
      events,
    }),
  });
  const caller = (principal: ReturnType<typeof user> | null) =>
    appRouter.createCaller({
      principal,
      services: { artifacts: service },
    } as unknown as Context);
  const files = (body: string) => [{ path: "index.html", text: body }];
  const made = async () =>
    (
      await service.create(u1, {
        files: files("<h1>x</h1>"),
        kind: "page",
        title: "Report",
      })
    ).artifactId;
  return { caller, files, made, service };
};

test("signed-out and anonymous callers are unauthorized", async () => {
  const { caller } = setup();
  const anonymous = appRouter.createCaller({
    principal: { kind: "anonymous" },
    services: {},
  } as unknown as Context);
  await expect(caller(null).artifacts.list({})).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(anonymous.artifacts.list({})).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    anonymous.artifacts.get({ artifactId: crypto.randomUUID() })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("a private artifact of another user is not found", async () => {
  const { caller, made } = setup();
  const artifactId = await made();
  const other = caller(u2).artifacts;
  const calls = [
    () => other.get({ artifactId }),
    () => other.versions({ artifactId }),
    () => other.rename({ artifactId, title: "Mine" }),
    () => other.restore({ artifactId, version: 1 }),
    () => other.setAudience({ artifactId, audience: "workspace" }),
    () => other.remove({ artifactId }),
  ];
  for (const call of calls) {
    // biome-ignore lint/performance/noAwaitInLoops: failures are checked one at a time
    await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
  }
  expect((await other.list({})).items).toEqual([]);
});

test("a member who is not the owner may read a workspace artifact but not manage it", async () => {
  const { caller, made } = setup();
  const artifactId = await made();
  await caller(u1).artifacts.setAudience({ artifactId, audience: "workspace" });
  const other = caller(u2).artifacts;
  expect((await other.get({ artifactId })).canManage).toBe(false);
  expect((await other.list({})).items).toHaveLength(1);
  expect(await other.versions({ artifactId })).toHaveLength(1);
  const calls = [
    () => other.rename({ artifactId, title: "Mine" }),
    () => other.setAudience({ artifactId, audience: "private" }),
    () => other.remove({ artifactId }),
    () => other.restore({ artifactId, version: 1 }),
  ];
  for (const call of calls) {
    // biome-ignore lint/performance/noAwaitInLoops: failures are checked one at a time
    await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
  }
});

test("the owner lists, reads, renames, restores and removes", async () => {
  const { caller, files, made, service } = setup();
  const artifactId = await made();
  const api = caller(u1).artifacts;

  const listed = await api.list({});
  expect(listed.items[0]).toMatchObject({
    artifactId,
    audience: "private",
    kind: "page",
    title: "Report",
  });
  const detail = await api.get({ artifactId });
  expect(detail.canManage).toBe(true);
  expect(detail.currentVersion.number).toBe(1);

  expect(await api.rename({ artifactId, title: "Renamed" })).toEqual({});
  expect((await api.get({ artifactId })).title).toBe("Renamed");

  await service.update(u1, {
    artifactId,
    baseVersion: 1,
    files: files("<h1>two</h1>"),
  });
  expect((await api.versions({ artifactId })).map((v) => v.number)).toEqual([
    2, 1,
  ]);
  expect(await api.restore({ artifactId, version: 1 })).toEqual({
    version: 3,
  });

  expect(await api.remove({ artifactId })).toEqual({});
  await expect(api.get({ artifactId })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("a caller without the artifacts service gets an internal error", async () => {
  const caller = appRouter.createCaller({
    principal: u1,
    services: {},
  } as unknown as Context);
  await expect(caller.artifacts.list({})).rejects.toMatchObject({
    code: "INTERNAL_SERVER_ERROR",
  });
});

test("invalid input is a bad request", async () => {
  const { caller, made } = setup();
  const artifactId = await made();
  const api = caller(u1).artifacts;
  await expect(api.rename({ artifactId, title: "" })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  await expect(api.restore({ artifactId, version: 0 })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});

test("list filters by the run that wrote a version", async () => {
  const { caller, made } = setup();
  await made();
  const api = caller(u1).artifacts;
  expect((await api.list({})).items).toHaveLength(1);
  expect((await api.list({ runId: "r-none" })).items).toEqual([]);
});
