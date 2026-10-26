import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiskLocal, createFileManifest } from "./transfer-local.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** The stat of a path, or null when it does not exist. */
const orNullStat = (path: string) =>
  lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });

let root = "";
let dir = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "transfer-local-"));
  dir = join(root, "copy");
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("createDiskLocal", () => {
  test("round trip of write, read, list, stat and remove", async () => {
    const local = createDiskLocal(dir);
    await local.write("agents/ada/notes.md", encode("hello"));

    expect(decode(await local.read("agents/ada/notes.md"))).toBe("hello");
    expect(await local.stat("agents/ada/notes.md")).toEqual({
      kind: "file",
      size: 5,
    });
    expect(await local.list("agents/ada")).toEqual([
      { kind: "file", name: "notes.md" },
    ]);
    expect(await readFile(join(dir, "agents/ada/notes.md"), "utf8")).toBe(
      "hello"
    );

    await local.remove("agents/ada/notes.md");
    expect(await local.stat("agents/ada/notes.md")).toBeNull();
  });

  test("nested folders are made on write and listed as folders", async () => {
    const local = createDiskLocal(dir);
    await local.write("a/b/c/file.txt", encode("x"));

    expect(await local.stat("a")).toEqual({
      kind: "dir",
      size: expect.any(Number),
    });
    expect(await local.list("")).toEqual([{ kind: "dir", name: "a" }]);
    expect(await local.list("a")).toEqual([{ kind: "dir", name: "b" }]);
  });

  test("a missing folder lists as empty and its stat is null", async () => {
    const local = createDiskLocal(dir);

    expect(await local.list("nope")).toEqual([]);
    expect(await local.stat("nope")).toBeNull();
    expect(await local.list("")).toEqual([]);
  });

  test("remove ignores a missing file", async () => {
    const local = createDiskLocal(dir);
    await local.remove("never/there.md");
  });

  test("a symlink is left out of list and gives null from stat", async () => {
    const local = createDiskLocal(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(root, "outside.txt"), "secret");
    await symlink(join(root, "outside.txt"), join(dir, "link.txt"));
    await symlink(root, join(dir, "linked-folder"));
    await writeFile(join(dir, "real.txt"), "ok");

    expect(await local.list("")).toEqual([{ kind: "file", name: "real.txt" }]);
    expect(await local.stat("link.txt")).toBeNull();
    expect(await local.stat("linked-folder")).toBeNull();
  });

  test("a folder that is a link lists as empty", async () => {
    const local = createDiskLocal(dir);
    await mkdir(join(root, "elsewhere"), { recursive: true });
    await writeFile(join(root, "elsewhere", "inside.txt"), "x");
    await mkdir(dir, { recursive: true });
    await symlink(join(root, "elsewhere"), join(dir, "agents"));

    expect(await local.list("agents")).toEqual([]);
  });

  test("traversal and absolute paths are refused", async () => {
    const local = createDiskLocal(dir);

    const paths = ["../x", "/etc/passwd", "a/../../x", "a/..", "a\0b"];
    await Promise.all(
      paths.flatMap((path) => [
        expect(local.write(path, encode("x"))).rejects.toThrow(),
        expect(local.read(path)).rejects.toThrow(),
        expect(local.remove(path)).rejects.toThrow(),
        expect(local.stat(path)).rejects.toThrow(),
        expect(local.list(path)).rejects.toThrow(),
      ])
    );
    expect(await orNullStat(join(root, "x"))).toBeNull();
  });

  test("the empty path is the folder itself for list and stat, and refused for file calls", async () => {
    const local = createDiskLocal(dir);
    await local.write("f.txt", encode("x"));

    expect(await local.stat("")).toEqual({
      kind: "dir",
      size: expect.any(Number),
    });
    expect(await local.list("")).toEqual([{ kind: "file", name: "f.txt" }]);
    await expect(local.write("", encode("x"))).rejects.toThrow();
    await expect(local.read("")).rejects.toThrow();
  });
});

describe("createFileManifest", () => {
  test("a missing file loads as an empty list", async () => {
    const manifest = createFileManifest(join(root, "missing", "manifest.json"));

    expect(await manifest.load()).toEqual([]);
  });

  test("a corrupt file loads as an empty list", async () => {
    const file = join(root, "manifest.json");
    await writeFile(file, "{not json");

    expect(await createFileManifest(file).load()).toEqual([]);
  });

  test("a file that is valid JSON but not an array loads as an empty list", async () => {
    const file = join(root, "manifest.json");
    await writeFile(
      file,
      JSON.stringify({ etag: "a", path: "b", sha256: "c" })
    );

    expect(await createFileManifest(file).load()).toEqual([]);
  });

  test("entries that are not complete are dropped and the rest are kept", async () => {
    const file = join(root, "manifest.json");
    const good = { etag: "e1", path: "agents/ada/a.md", sha256: "h1" };
    await writeFile(
      file,
      JSON.stringify([
        good,
        { etag: "e2", path: "missing-hash" },
        { etag: 3, path: "bad-etag", sha256: "h" },
        "text",
        null,
        { etag: "e3", path: "extra", sha256: "h3", size: 9 },
      ])
    );

    expect(await createFileManifest(file).load()).toEqual([
      good,
      { etag: "e3", path: "extra", sha256: "h3" },
    ]);
  });

  test("save and load round trip, making the folder above the file", async () => {
    const file = join(root, "state", "manifest.json");
    const manifest = createFileManifest(file);
    const entries = [{ etag: "e1", path: "agents/ada/a.md", sha256: "h1" }];

    await manifest.save(entries);

    expect(await manifest.load()).toEqual(entries);
    expect(await orNullStat(`${file}.tmp`)).toBeNull();
  });

  test("a later save replaces the earlier manifest", async () => {
    const file = join(root, "manifest.json");
    const manifest = createFileManifest(file);
    await manifest.save([{ etag: "e1", path: "a", sha256: "h1" }]);
    await manifest.save([]);

    expect(await manifest.load()).toEqual([]);
  });
});
