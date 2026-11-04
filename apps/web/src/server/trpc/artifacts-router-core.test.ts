import { expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import {
  artifactsFilesOutputSchema,
  artifactsReadFileOutputSchema,
} from "@repo/protocol/artifacts";
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
    () => other.files({ artifactId }),
    () => other.readFile({ artifactId, path: "index.html" }),
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

test("source queries follow the chosen version and are available to readers", async () => {
  const { caller, made, service, files } = setup();
  const artifactId = await made();
  await service.update(u1, {
    artifactId,
    baseVersion: 1,
    files: files("second"),
  });
  await caller(u1).artifacts.setAudience({ artifactId, audience: "workspace" });
  const api = caller(u2).artifacts;
  const listed = await api.files({ artifactId, version: 1 });
  expect(artifactsFilesOutputSchema.parse(listed)).toEqual(listed);
  expect(listed).toMatchObject({
    entry: "index.html",
    files: [
      { contentType: "text/html; charset=utf-8", path: "index.html", size: 10 },
    ],
    version: 1,
  });
  const old = await api.readFile({
    artifactId,
    path: "index.html",
    version: 1,
  });
  expect(artifactsReadFileOutputSchema.parse(old)).toEqual(old);
  expect(old).toMatchObject({
    text: "<h1>x</h1>",
    truncated: false,
    version: 1,
  });
  expect(await api.readFile({ artifactId, path: "index.html" })).toMatchObject({
    text: "second",
    version: 2,
  });
  expect((await api.files({ artifactId })).version).toBe(2);
  expect(
    artifactsFilesOutputSchema.safeParse({ ...listed, secret: "hidden" })
      .success
  ).toBe(false);
  expect(
    artifactsReadFileOutputSchema.safeParse({ ...old, secret: "hidden" })
      .success
  ).toBe(false);
  await expect(api.files({ artifactId, version: 99 })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(
    api.readFile({ artifactId, path: "missing.txt" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    caller(null).artifacts.files({ artifactId })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    caller(null).artifacts.readFile({ artifactId, path: "index.html" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("source text previews stop at 512 KB on a UTF-8 boundary", async () => {
  const { caller, service } = setup();
  const { artifactId } = await service.create(u1, {
    files: [
      { path: "index.html", text: `${"a".repeat(512 * 1024 - 1)}éend` },
      { base64: "cG5n", path: "image.png" },
    ],
    kind: "page",
    title: "Large",
  });
  const read = await caller(u1).artifacts.readFile({
    artifactId,
    path: "index.html",
  });
  expect(read.truncated).toBe(true);
  expect(read.text).toBe("a".repeat(512 * 1024 - 1));
  expect(read.size).toBe(512 * 1024 + 4);
  await expect(
    caller(u1).artifacts.readFile({ artifactId, path: "image.png" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});
