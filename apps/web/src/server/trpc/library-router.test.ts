import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { bytesToBase64 } from "#/lib/library-content.ts";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("Expected a value");
  }
  return value;
};

const ORG_IDS = ["org_a", "org_b"];
const MB = 1024 * 1024;

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

test("a user writes a text file in a new folder and reads it back", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  const written = await caller.library.write({
    data: "# Notes",
    encoding: "text",
    path: "docs/notes/a.md",
  });
  expect(written.path).toBe("docs/notes/a.md");

  const root = await caller.library.list({});
  expect(root.map((entry) => [entry.path, entry.kind])).toEqual([
    ["docs", "dir"],
  ]);
  const inside = await caller.library.list({ dir: "docs/notes" });
  expect(inside.map((entry) => [entry.path, entry.kind])).toEqual([
    ["docs/notes/a.md", "file"],
  ]);

  const file = await caller.library.read({ path: "docs/notes/a.md" });
  expect(file.text).toBe("# Notes");
  expect(file.entry.etag).toEqual(expect.any(String));
});

test("bytes that are not UTF-8 read back with no text", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  await caller.library.write({
    data: bytesToBase64(new Uint8Array([0xff, 0xfe, 0x00, 0x01])),
    encoding: "base64",
    path: "blob.bin",
  });

  const file = await caller.library.read({ path: "blob.bin" });
  expect(file.text).toBeNull();
  expect(file.entry.size).toBe(4);
});

test("a file over 1 MB reads back with no text and its real size", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  await caller.library.write({
    data: "a".repeat(MB + 1),
    encoding: "text",
    path: "big.txt",
  });

  const file = await caller.library.read({ path: "big.txt" });
  expect(file.text).toBeNull();
  expect(file.entry.size).toBe(MB + 1);
});

test("a write with a stale etag is a CONFLICT", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  await caller.library.write({
    data: "v1",
    encoding: "text",
    path: "draft.txt",
  });

  await expect(
    caller.library.write({
      data: "v2",
      encoding: "text",
      ifEtag: "stale-etag",
      path: "draft.txt",
    })
  ).rejects.toMatchObject({ code: "CONFLICT" });
});

test("a folder removed with recursive true leaves the library empty", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  await caller.library.mkdir({ path: "old" });
  await caller.library.write({
    data: "x",
    encoding: "text",
    path: "old/a.txt",
  });

  await caller.library.remove({ path: "old", recursive: true });

  expect(await caller.library.list({})).toEqual([]);
});

test("another workspace cannot read the file", async () => {
  const owner = await callerFor({ orgId: "org_a", userId: "user_1" });
  await owner.library.write({
    data: "secret",
    encoding: "text",
    path: "plan.txt",
  });
  const other = await callerFor({ orgId: "org_b", userId: "user_2" });

  await expect(other.library.read({ path: "plan.txt" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("a caller without a session gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(caller.library.list({})).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(caller.library.read({ path: "a.txt" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("version procedures compare and restore history after move and delete", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  await caller.library.write({ data: "old", encoding: "text", path: "a" });
  await caller.library.write({ data: "new", encoding: "text", path: "a" });
  const [second, first] = await caller.library.versions({ path: "a" });
  expect(
    await caller.library.compare({
      a: required(first).id,
      b: required(second).id,
    })
  ).toEqual({ a: "old", b: "new", kind: "text" });
  expect(
    (await caller.library.readVersion({ versionId: required(first).id })).text
  ).toBe("old");
  await caller.library.move({ from: "a", to: "b" });
  await caller.library.remove({ path: "b" });
  await caller.library.restore({ versionId: required(first).id });
  expect((await caller.library.stat({ path: "b" })).kind).toBe("file");
  expect((await caller.library.read({ path: "b" })).text).toBe("old");
});

test("conflict procedures list workspace rows, validate choices and require a session", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  expect(await caller.library.conflicts.list()).toEqual([]);
  await expect(
    caller.library.conflicts.resolve({ choice: "keep-library", id: "missing" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  const anonymous = await callerFor({ orgId: "org_a", userId: null });
  await expect(anonymous.library.conflicts.list()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    anonymous.library.conflicts.resolve({ choice: "keep-agent", id: "missing" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
