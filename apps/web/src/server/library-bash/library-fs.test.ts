import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { libraryEntries } from "@repo/db/schema/library";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createEventsService } from "@repo/services/events";
import { createLibraryService } from "@repo/services/library";
import {
  type MemoryLibraryBlobs,
  memoryLibraryBlobs,
} from "@repo/services/library/memory";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { asc, eq } from "drizzle-orm";
import { Bash, InMemoryFs, MountableFs } from "just-bash/browser";
import {
  createLibraryFs,
  type LibraryOps,
  STORAGE_BUDGET_MESSAGE,
} from "./library-fs.ts";

const WORKSPACE = "w1";
const START = "2026-10-16T10:00:00.000Z";

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};

const bytes = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

let db: ReturnType<typeof migrated>;
let blobs: MemoryLibraryBlobs;
let service: ReturnType<typeof createLibraryService>;

/** The library service with the principal bound, which is what the app passes in. */
const boundOps = (): LibraryOps => ({
  list: (dir) => service.list(user, dir),
  mkdir: (path) => service.mkdir(user, path),
  move: (from, to) => service.move(user, from, to),
  read: (path) => service.read(user, path),
  remove: (path, options) => service.remove(user, path, options),
  stat: (path) => service.stat(user, path),
  write: (path, content, options) =>
    service.write(user, path, content, options),
});

const mount = (
  options: {
    budget?: number;
    ops?: LibraryOps;
    onBudgetExceeded?: () => void;
  } = {}
) =>
  createLibraryFs({
    budget: options.budget ?? 1000,
    onBudgetExceeded: options.onBudgetExceeded,
    ops: options.ops ?? boundOps(),
  });

const libraryPaths = () =>
  db
    .select()
    .from(libraryEntries)
    .where(eq(libraryEntries.workspaceId, WORKSPACE))
    .orderBy(asc(libraryEntries.path))
    .all()
    .map((row) => row.path);

beforeEach(() => {
  db = migrated();
  blobs = memoryLibraryBlobs();
  const eventsService = createEventsService({
    blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    db,
  });
  service = createLibraryService({
    atomic: sqliteAtomic(db),
    blobs,
    clock: systemClock,
    db,
    events: eventsService,
  });
  db.insert(workspaceRows)
    .values({
      clerkOrgId: `org_${WORKSPACE}`,
      createdAt: START,
      id: WORKSPACE,
      name: WORKSPACE,
      timezone: "UTC",
    })
    .run();
});

test("a written file reads back as text and as bytes", async () => {
  const { fs } = mount();
  await fs.writeFile("/a/x.md", "hello");
  expect(await fs.readFile("/a/x.md")).toBe("hello");
  expect(decode(await fs.readFileBuffer("/a/x.md"))).toBe("hello");

  await fs.writeFile("/a/raw.bin", new Uint8Array([0, 255, 7]));
  expect(await fs.readFileBuffer("/a/raw.bin")).toEqual(
    new Uint8Array([0, 255, 7])
  );
});

test("readdir returns sorted names and readdirWithFileTypes returns dirents", async () => {
  const { fs } = mount();
  await fs.writeFile("/d/b.md", "b");
  await fs.writeFile("/d/a.md", "a");
  await fs.mkdir("/d/c");

  expect(await fs.readdir("/d")).toEqual(["a.md", "b.md", "c"]);
  expect(await fs.readdirWithFileTypes?.("/d")).toEqual([
    { isDirectory: false, isFile: true, isSymbolicLink: false, name: "a.md" },
    { isDirectory: false, isFile: true, isSymbolicLink: false, name: "b.md" },
    { isDirectory: true, isFile: false, isSymbolicLink: false, name: "c" },
  ]);
  expect(await fs.readdir("/")).toEqual(["d"]);
});

test("stat gives the kind, mode, size and identity of a file, a folder and the root", async () => {
  const { fs } = mount();
  await fs.writeFile("/d/a.md", "four");

  expect(await fs.stat("/d/a.md")).toMatchObject({
    identity: "library:/d/a.md",
    isDirectory: false,
    isFile: true,
    mode: 0o644,
    size: 4,
  });
  expect(await fs.stat("/d")).toMatchObject({
    identity: "library:/d",
    isDirectory: true,
    isFile: false,
    mode: 0o755,
  });
  expect(await fs.stat("/")).toMatchObject({
    identity: "library:/",
    isDirectory: true,
    isFile: false,
  });
});

test("reading a missing file fails with ENOENT in the message and the code", async () => {
  const { fs } = mount();
  await expect(fs.readFile("/missing.md")).rejects.toMatchObject({
    code: "ENOENT",
    message: "ENOENT: no such file or directory, open '/missing.md'",
  });
});

test("reading a folder fails with EISDIR", async () => {
  const { fs } = mount();
  await fs.writeFile("/d/a.md", "a");
  await expect(fs.readFile("/d")).rejects.toMatchObject({ code: "EISDIR" });
  await expect(fs.readFile("/")).rejects.toMatchObject({ code: "EISDIR" });
});

test("mkdir without recursive fails with EEXIST when the folder exists and ENOENT when the parent is missing", async () => {
  const { fs } = mount();
  await fs.mkdir("/n");
  await expect(fs.mkdir("/n")).rejects.toMatchObject({ code: "EEXIST" });
  await expect(fs.mkdir("/p/q")).rejects.toMatchObject({ code: "ENOENT" });
});

test("mkdir with recursive creates the parents and a file in the way is EEXIST", async () => {
  const { fs } = mount();
  await fs.mkdir("/x/y/z", { recursive: true });
  expect(await fs.stat("/x/y/z")).toMatchObject({ isDirectory: true });
  expect(await fs.readdir("/x")).toEqual(["y"]);
  await fs.mkdir("/x/y/z", { recursive: true });

  await fs.writeFile("/x/file.md", "f");
  await expect(
    fs.mkdir("/x/file.md", { recursive: true })
  ).rejects.toMatchObject({ code: "EEXIST" });
});

test("rm recursive removes a folder tree, and rm without recursive refuses a folder with children", async () => {
  const { fs } = mount();
  await fs.writeFile("/t/a.md", "a");
  await expect(fs.rm("/t")).rejects.toMatchObject({ code: "ENOTEMPTY" });
  expect(await fs.exists("/t/a.md")).toBe(true);

  await fs.rm("/t", { recursive: true });
  expect(await fs.exists("/t")).toBe(false);
  expect(await fs.exists("/t/a.md")).toBe(false);
});

test("rm with force on a missing path is silent and without it is ENOENT", async () => {
  const { fs } = mount();
  await fs.rm("/nope", { force: true });
  await expect(fs.rm("/nope")).rejects.toMatchObject({ code: "ENOENT" });
});

test("mv puts a file over an existing file", async () => {
  const { fs } = mount();
  await fs.writeFile("/m/a.md", "A");
  await fs.writeFile("/m/b.md", "B");
  await fs.mv("/m/a.md", "/m/b.md");
  expect(await fs.readFile("/m/b.md")).toBe("A");
  expect(await fs.exists("/m/a.md")).toBe(false);
});

test("cp with recursive copies a folder tree and cp of a folder without it is EISDIR", async () => {
  const { fs } = mount();
  await fs.writeFile("/s/a.md", "a");
  await fs.writeFile("/s/sub/b.md", "b");

  await expect(fs.cp("/s", "/t3")).rejects.toMatchObject({ code: "EISDIR" });

  await fs.cp("/s", "/t2", { recursive: true });
  expect(await fs.readdir("/t2")).toEqual(["a.md", "sub"]);
  expect(await fs.readFile("/t2/sub/b.md")).toBe("b");
  expect(await fs.readFile("/s/sub/b.md")).toBe("b");
});

test("appendFile creates the file and then appends to it", async () => {
  const { fs } = mount();
  await fs.appendFile("/log.md", "a");
  await fs.appendFile("/log.md", "b");
  expect(await fs.readFile("/log.md")).toBe("ab");
});

test("appendFile reads again and retries when the file changed after its read", async () => {
  await service.write(user, "log.md", bytes("one\n"));
  let writes = 0;
  const ops: LibraryOps = {
    ...boundOps(),
    write: (path, content, options) => {
      writes += 1;
      if (writes === 1) {
        // Another writer lands between this append's read and its write.
        return service
          .write(user, path, bytes("changed\n"))
          .then(() => service.write(user, path, content, options));
      }
      return service.write(user, path, content, options);
    },
  };
  const { fs } = mount({ ops });

  await fs.appendFile("/log.md", "two\n");

  expect(writes).toBe(2);
  expect(await fs.readFile("/log.md")).toBe("changed\ntwo\n");
});

test("a call past the storage budget fails with the budget message and EIO, and only the first refusal calls back", async () => {
  let refused = 0;
  const { fs, storageCalls, budgetExceeded } = mount({
    budget: 5,
    onBudgetExceeded: () => {
      refused += 1;
    },
  });
  for (let index = 1; index <= 5; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each call must finish before the next is counted
    await fs.writeFile(`/f${index}.md`, "x");
  }
  expect(storageCalls()).toBe(5);

  const message = STORAGE_BUDGET_MESSAGE(5);
  await expect(fs.writeFile("/f6.md", "x")).rejects.toMatchObject({
    code: "EIO",
    message,
  });
  await expect(fs.readFile("/f1.md")).rejects.toMatchObject({
    code: "EIO",
    message,
  });

  expect(refused).toBe(1);
  expect(budgetExceeded()).toBe(true);
  expect(storageCalls()).toBe(5);
  expect(libraryPaths()).not.toContain("f6.md");
});

test("a .. past the root stays at the root and the file lands in the library", async () => {
  const { fs } = mount();
  await fs.writeFile("/../../x.md", "x");
  expect(await fs.readFile("/x.md")).toBe("x");
  expect(await fs.readdir("/")).toEqual(["x.md"]);
  expect(fs.resolvePath("/", "../..")).toBe("/");
  expect(await fs.realpath("/a/../../x.md")).toBe("/x.md");
  expect(libraryPaths()).toEqual(["x.md"]);
});

test("the library mounted in just-bash runs mkdir, redirects, grep, sed, ls and cp", async () => {
  const shell = new Bash({
    cwd: "/library",
    executionLimitProfile: "hardened",
    fs: new MountableFs({
      base: new InMemoryFs(),
      mounts: [{ filesystem: mount().fs, mountPoint: "/library" }],
    }),
  });
  const run = (script: string) => shell.exec(script, { rawScript: true });

  expect(await run("mkdir -p a && echo hi > a/x.md")).toMatchObject({
    exitCode: 0,
  });
  expect(await run("cat a/x.md")).toMatchObject({
    exitCode: 0,
    stdout: "hi\n",
  });
  expect(await run("grep -rn hi .")).toMatchObject({
    exitCode: 0,
    stdout: "a/x.md:1:hi\n",
  });
  expect(await run("sed -i s/hi/ho/ a/x.md && cat a/x.md")).toMatchObject({
    exitCode: 0,
    stdout: "ho\n",
  });
  expect(await run("ls -R | wc -l")).toMatchObject({
    exitCode: 0,
    stdout: "5\n",
  });
  expect(await run("cp -r a b && ls b")).toMatchObject({
    exitCode: 0,
    stdout: "x.md\n",
  });
});
