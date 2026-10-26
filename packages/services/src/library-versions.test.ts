// biome-ignore-all lint/performance/noAwaitInLoops: history mutations and retention fixtures must run in order
import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import { libraryEntries, libraryVersions } from "@repo/db/schema/library";
import { workspaces } from "@repo/db/schema/workspaces";
import type { LibraryChange } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { createEventsService } from "./events.ts";
import { memoryLibraryBlobs } from "./library/memory.ts";
import { createLibraryService } from "./library.ts";

const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("Expected a value");
  }
  return value;
};

const principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: "w1",
} as const;
const bytes = (text: string) => new TextEncoder().encode(text);
let db: ReturnType<typeof migrated>;
let blobs: ReturnType<typeof memoryLibraryBlobs>;
let service: ReturnType<typeof createLibraryService>;
let changes: LibraryChange[];
let now: string;
let fail: boolean;
beforeEach(() => {
  db = migrated();
  blobs = memoryLibraryBlobs();
  changes = [];
  now = "2026-01-01T00:00:00.000Z";
  fail = false;
  db.insert(workspaces)
    .values({
      clerkOrgId: "org1",
      createdAt: now,
      id: "w1",
      name: "test",
      timezone: "UTC",
    })
    .run();
  const atomic = sqliteAtomic(db);
  service = createLibraryService({
    atomic: (statements) =>
      fail ? Promise.reject(new Error("batch failed")) : atomic(statements),
    blobs,
    clock: { now: () => new Date(now), sleep: async () => undefined },
    db,
    events: createEventsService({
      blobs: { get: async () => null, put: async () => undefined },
      db,
    }),
    notify: (change) => {
      changes.push(change);
    },
  });
});

test("writes, compare, restore and tombstones preserve immutable bytes", async () => {
  await service.write(principal, "a", bytes("old"));
  const current = await service.write(principal, "a", bytes("new"));
  const [second, first] = await service.versions(principal, "a");
  expect([second?.version, first?.version]).toEqual([2, 1]);
  expect(
    await service.compare(principal, required(first).id, required(second).id)
  ).toEqual({
    a: "old",
    b: "new",
    kind: "text",
  });
  await service.restore(principal, required(first).id, {
    ifEtag: required(current.etag),
  });
  expect((await service.versions(principal, "a"))[0]).toMatchObject({
    op: "restore",
    version: 3,
  });
  expect((await service.read(principal, "a")).bytes).toEqual(bytes("old"));
  await service.remove(principal, "a");
  expect((await service.versions(principal, "a"))[0]).toMatchObject({
    blobKey: null,
    op: "delete",
  });
  await service.restore(principal, required(first).id, {});
  expect((await service.read(principal, "a")).bytes).toEqual(bytes("old"));
  expect(
    db
      .select()
      .from(eventRows)
      .all()
      .filter((row) => row.type === "library.restore")
  ).toHaveLength(2);
  expect(changes).toHaveLength(5);
});

test("move carries source and overwritten destination history without key changes", async () => {
  await service.write(principal, "a", bytes("source"));
  const [original] = await service.versions(principal, "a");
  await service.write(principal, "b", bytes("target"));
  const moved = await service.move(principal, "a", "b");
  expect(await service.versions(principal, "a")).toEqual([]);
  const history = await service.versions(principal, "b");
  expect(history).toHaveLength(3);
  expect(history[0]?.etag).toBe(required(moved.etag));
  expect(history.find((row) => row.id === required(original).id)?.blobKey).toBe(
    required(original).blobKey
  );
  expect(
    (await service.readVersion(principal, required(original).id)).bytes
  ).toEqual(bytes("source"));
  expect(changes.at(-1)).toEqual({
    byRunId: null,
    paths: ["a", "b"],
    workspaceId: "w1",
  });
});

test("old files are snapshotted on first write, recursive remove and move", async () => {
  for (const path of ["write", "dir/remove", "move"]) {
    const stored = await blobs.put(`w1/library/${path}`, bytes(path));
    db.insert(libraryEntries)
      .values({
        etag: required(stored).etag,
        kind: "file",
        mtime: now,
        parent: path.includes("/") ? "dir" : "",
        path,
        size: path.length,
        updatedById: "original",
        updatedByKind: "user",
        workspaceId: "w1",
      })
      .run();
  }
  expect(await service.versions(principal, "write")).toEqual([]);
  await service.write(principal, "write", bytes("changed"));
  await service.mkdir(principal, "dir");
  await service.remove(principal, "dir", { recursive: true });
  await service.move(principal, "move", "moved");
  for (const path of ["write", "dir/remove", "moved"]) {
    const history = await service.versions(principal, path);
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      authorId: "original",
      createdAt: now,
      op: "write",
    });
  }
});

test("failed CAS or batch does not commit history or notify", async () => {
  await service.write(principal, "a", bytes("old"));
  await expect(
    service.write(principal, "a", bytes("no"), { ifEtag: "wrong" })
  ).rejects.toMatchObject({ code: "conflict" });
  fail = true;
  await expect(service.write(principal, "a", bytes("no"))).rejects.toThrow(
    "batch failed"
  );
  expect(await service.versions(principal, "a")).toHaveLength(1);
  expect(changes).toHaveLength(1);
});

test("binary compare, tombstone reads and workspace isolation", async () => {
  await service.write(principal, "a", new Uint8Array([255, 0]));
  const [version] = await service.versions(principal, "a");
  expect(
    await service.compare(principal, required(version).id, required(version).id)
  ).toEqual({
    kind: "binary",
  });
  await expect(
    service.readVersion(
      { ...principal, workspaceId: "other" },
      required(version).id
    )
  ).rejects.toMatchObject({ code: "not_found" });
  await service.remove(principal, "a");
  const [deleted] = await service.versions(principal, "a");
  await expect(
    service.restore(principal, required(deleted).id, {})
  ).rejects.toMatchObject({ code: "invalid" });
});

test("prune keeps newest 20 and recent versions, clears expired tombstoned histories and blobs twice safely", async () => {
  for (let i = 0; i < 25; i += 1) {
    await service.write(principal, "a", bytes(String(i)));
  }
  await service.write(principal, "deleted", bytes("bye"));
  await service.remove(principal, "deleted");
  const old = await service.versions(principal, "a");
  now = "2026-03-01T00:00:00.000Z";
  await service.write(principal, "a", bytes("recent"));
  await service.pruneVersions(new Date(now));
  await service.pruneVersions(new Date(now));
  expect(await service.versions(principal, "a")).toHaveLength(20);
  expect(await service.versions(principal, "deleted")).toEqual([]);
  for (const row of old.slice(19)) {
    expect(blobs.objects.has(required(row.blobKey))).toBe(false);
  }
  now = "2026-03-02T00:00:00.000Z";
  for (let i = 0; i < 22; i += 1) {
    await service.write(principal, "a", bytes(String(i)));
  }
  await service.pruneVersions(new Date(now));
  expect(await service.versions(principal, "a")).toHaveLength(23);
  expect(db.select().from(libraryVersions).all()).toHaveLength(23);
});

test("failed delete, move and restore batches leave entries, events, history and notifications unchanged", async () => {
  await service.write(principal, "a", bytes("original"));
  const [version] = await service.versions(principal, "a");
  fail = true;
  await expect(service.remove(principal, "a")).rejects.toThrow("batch failed");
  await expect(service.move(principal, "a", "b")).rejects.toThrow(
    "batch failed"
  );
  await expect(
    service.restore(principal, required(version).id)
  ).rejects.toThrow("batch failed");
  expect(await service.versions(principal, "a")).toHaveLength(1);
  expect(await service.versions(principal, "b")).toEqual([]);
  expect(
    db
      .select()
      .from(libraryEntries)
      .all()
      .map((row) => row.path)
  ).toEqual(["a"]);
  expect(db.select().from(eventRows).all()).toHaveLength(1);
  expect(changes).toHaveLength(1);
});

test("a prune retry finishes an expired tombstone history spanning multiple batches", async () => {
  for (let i = 0; i < 95; i += 1) {
    await service.write(principal, "a", bytes(String(i)));
  }
  await service.remove(principal, "a");
  now = "2026-03-01T00:00:00.000Z";
  const remove = blobs.delete;
  let calls = 0;
  blobs.delete = (keys) => {
    calls += 1;
    return calls === 2
      ? Promise.reject(new Error("storage unavailable"))
      : remove(keys);
  };
  await expect(service.pruneVersions(new Date(now))).rejects.toThrow(
    "storage unavailable"
  );
  blobs.delete = remove;
  await service.pruneVersions(new Date(now));
  expect(await service.versions(principal, "a")).toEqual([]);
  expect(blobs.objects.size).toBe(0);
});

test("concurrent writes to one path get distinct version numbers", async () => {
  await Promise.all([
    service.write(principal, "race", bytes("one")),
    service.write(principal, "race", bytes("two")),
  ]);
  const versions = await service.versions(principal, "race");
  expect(versions.map((version) => version.version)).toEqual([2, 1]);
});

test("restore with a stale etag conflicts and adds no version", async () => {
  const first = await service.write(principal, "a", bytes("one"));
  await service.write(principal, "a", bytes("two"));
  const [, original] = await service.versions(principal, "a");
  await expect(
    service.restore(principal, required(original).id, {
      ifEtag: required(first.etag),
    })
  ).rejects.toMatchObject({ code: "conflict" });
  expect(await service.versions(principal, "a")).toHaveLength(2);
});

test("a throwing notify does not fail a committed change or skip blob cleanup", async () => {
  const noisy = createLibraryService({
    atomic: sqliteAtomic(db),
    blobs,
    clock: { now: () => new Date(now), sleep: async () => undefined },
    db,
    events: createEventsService({
      blobs: { get: async () => null, put: async () => undefined },
      db,
    }),
    notify: () => Promise.reject(new Error("listener down")),
  });
  await noisy.write(principal, "n", bytes("x"));
  await noisy.remove(principal, "n");
  expect(await blobs.get("w1/library/n")).toBeNull();
  expect((await noisy.versions(principal, "n"))[0]?.op).toBe("delete");
});
