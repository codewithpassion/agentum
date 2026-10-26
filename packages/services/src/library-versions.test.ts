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

const principal = { kind: "user", userId: "u1", via: "session", workspaceId: "w1" } as const;
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
  db.insert(workspaces).values({ createdAt: now, id: "w1", clerkOrgId: "org1", name: "test", timezone: "UTC" }).run();
  const atomic = sqliteAtomic(db);
  service = createLibraryService({
    atomic: (statements) => fail ? Promise.reject(new Error("batch failed")) : atomic(statements),
    blobs, clock: { now: () => new Date(now) }, db,
    events: createEventsService({ db, blobs: { get: async () => null, put: async () => undefined } }),
    notify: (change) => { changes.push(change); },
  });
});

test("writes, compare, restore and tombstones preserve immutable bytes", async () => {
  await service.write(principal, "a", bytes("old"));
  const current = await service.write(principal, "a", bytes("new"));
  const [second, first] = await service.versions(principal, "a");
  expect([second?.version, first?.version]).toEqual([2, 1]);
  expect(await service.compare(principal, first!.id, second!.id)).toEqual({ kind: "text", a: "old", b: "new" });
  await service.restore(principal, first!.id, { ifEtag: current.etag! });
  expect((await service.versions(principal, "a"))[0]).toMatchObject({ version: 3, op: "restore" });
  expect((await service.read(principal, "a")).bytes).toEqual(bytes("old"));
  await service.remove(principal, "a");
  expect((await service.versions(principal, "a"))[0]).toMatchObject({ op: "delete", blobKey: null });
  await service.restore(principal, first!.id, {});
  expect((await service.read(principal, "a")).bytes).toEqual(bytes("old"));
  expect(db.select().from(eventRows).all().filter((row) => row.type === "library.restore")).toHaveLength(2);
  expect(changes).toHaveLength(5);
});

test("move carries source and overwritten destination history without key changes", async () => {
  await service.write(principal, "a", bytes("source"));
  const [original] = await service.versions(principal, "a");
  await service.write(principal, "b", bytes("target"));
  await service.move(principal, "a", "b");
  expect(await service.versions(principal, "a")).toEqual([]);
  const history = await service.versions(principal, "b");
  expect(history).toHaveLength(3);
  expect(history.find((row) => row.id === original!.id)?.blobKey).toBe(original!.blobKey);
  expect((await service.readVersion(principal, original!.id)).bytes).toEqual(bytes("source"));
  expect(changes.at(-1)).toEqual({ byRunId: null, workspaceId: "w1", paths: ["a", "b"] });
});

test("old files are snapshotted on first write, recursive remove and move", async () => {
  for (const path of ["write", "dir/remove", "move"]) {
    const stored = await blobs.put(`w1/library/${path}`, bytes(path));
    db.insert(libraryEntries).values({ workspaceId: "w1", path, parent: path.includes("/") ? "dir" : "", kind: "file", size: path.length, etag: stored!.etag, mtime: now, updatedById: "original", updatedByKind: "user" }).run();
  }
  expect(await service.versions(principal, "write")).toEqual([]);
  await service.write(principal, "write", bytes("changed"));
  await service.mkdir(principal, "dir");
  await service.remove(principal, "dir", { recursive: true });
  await service.move(principal, "move", "moved");
  for (const path of ["write", "dir/remove", "moved"]) {
    const history = await service.versions(principal, path);
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({ authorId: "original", createdAt: now, op: "write" });
  }
});

test("failed CAS or batch does not commit history or notify", async () => {
  await service.write(principal, "a", bytes("old"));
  await expect(service.write(principal, "a", bytes("no"), { ifEtag: "wrong" })).rejects.toMatchObject({ code: "conflict" });
  fail = true;
  await expect(service.write(principal, "a", bytes("no"))).rejects.toThrow("batch failed");
  expect(await service.versions(principal, "a")).toHaveLength(1);
  expect(changes).toHaveLength(1);
});

test("binary compare, tombstone reads and workspace isolation", async () => {
  await service.write(principal, "a", new Uint8Array([255, 0]));
  const [version] = await service.versions(principal, "a");
  expect(await service.compare(principal, version!.id, version!.id)).toEqual({ kind: "binary" });
  await expect(service.readVersion({ ...principal, workspaceId: "other" }, version!.id)).rejects.toMatchObject({ code: "not_found" });
  await service.remove(principal, "a");
  const [deleted] = await service.versions(principal, "a");
  await expect(service.restore(principal, deleted!.id, {})).rejects.toMatchObject({ code: "invalid" });
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
    expect(blobs.objects.has(row.blobKey!)).toBe(false);
  }
  now = "2026-03-02T00:00:00.000Z";
  for (let i = 0; i < 22; i += 1) {
    await service.write(principal, "a", bytes(String(i)));
  }
  await service.pruneVersions(new Date(now));
  expect(await service.versions(principal, "a")).toHaveLength(23);
  expect(db.select().from(libraryVersions).all()).toHaveLength(23);
});
