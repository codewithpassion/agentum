import { describe, expect, test } from "bun:test";
import { sha256Of } from "./files.ts";
import { runSyncIn } from "./sync-in.ts";
import {
  bytesOf,
  createMemoryLocal,
  createMemoryManifest,
  createMemoryRemote,
  textOf,
} from "./testing.ts";
import type { SyncPorts } from "./types.ts";

const setup = () => {
  const remote = createMemoryRemote();
  const local = createMemoryLocal();
  const manifest = createMemoryManifest();
  const ports: SyncPorts = { local, manifest, remote };
  return { local, manifest, ports, remote };
};

const ADA = ["agents/ada"];

describe("runSyncIn", () => {
  test("first sync copies the files under the root and writes the manifest", async () => {
    const { local, manifest, ports, remote } = setup();
    const etag = remote.put("agents/ada/notes.md", "hello");
    const deepEtag = remote.put("agents/ada/sub/deep.md", "deep");

    const result = await runSyncIn(ports, { roots: ADA });

    expect(result.pulled).toEqual([
      "agents/ada/notes.md",
      "agents/ada/sub/deep.md",
    ]);
    expect(textOf(local.files.get("agents/ada/notes.md"))).toBe("hello");
    expect(textOf(local.files.get("agents/ada/sub/deep.md"))).toBe("deep");
    expect(manifest.saved).toEqual([
      {
        etag,
        path: "agents/ada/notes.md",
        sha256: await sha256Of(bytesOf("hello")),
      },
      {
        etag: deepEtag,
        path: "agents/ada/sub/deep.md",
        sha256: await sha256Of(bytesOf("deep")),
      },
    ]);
  });

  test("a root that is a single file copies only that file", async () => {
    const { local, ports, remote } = setup();
    remote.put("agents/ada/notes.md", "one");
    remote.put("agents/ada/other.md", "two");

    const result = await runSyncIn(ports, { roots: ["agents/ada/notes.md"] });

    expect(result.pulled).toEqual(["agents/ada/notes.md"]);
    expect([...local.files.keys()]).toEqual(["agents/ada/notes.md"]);
  });

  test("a root that does not exist adds nothing", async () => {
    const { local, manifest, ports, remote } = setup();
    remote.put("agents/ada/notes.md", "hello");

    const result = await runSyncIn(ports, { roots: ["agents/nobody"] });

    expect(result).toEqual({
      conflicts: [],
      failed: [],
      kept: [],
      pulled: [],
      removed: [],
      skipped: [],
    });
    expect(local.files.size).toBe(0);
    expect(manifest.saved).toEqual([]);
  });

  test("files outside the roots are not copied", async () => {
    const { local, ports, remote } = setup();
    remote.put("agents/ada/notes.md", "in");
    remote.put("agents/bob/notes.md", "out");

    await runSyncIn(ports, { roots: ADA });

    expect([...local.files.keys()]).toEqual(["agents/ada/notes.md"]);
  });

  test("a second sync with nothing changed makes no read on the remote", async () => {
    const { ports, remote } = setup();
    remote.put("agents/ada/notes.md", "hello");
    await runSyncIn(ports, { roots: ADA });
    remote.calls.length = 0;

    const result = await runSyncIn(ports, { roots: ADA });

    expect(remote.calls.filter((call) => call.startsWith("read "))).toEqual([]);
    expect(result.pulled).toEqual([]);
    expect(result.kept).toEqual([]);
  });

  test("a remote change replaces an unedited local file and updates the manifest", async () => {
    const { local, manifest, ports, remote } = setup();
    remote.put("agents/ada/notes.md", "v1");
    await runSyncIn(ports, { roots: ADA });
    const etag = remote.put("agents/ada/notes.md", "v2");

    const result = await runSyncIn(ports, { roots: ADA });

    expect(result.pulled).toEqual(["agents/ada/notes.md"]);
    expect(textOf(local.files.get("agents/ada/notes.md"))).toBe("v2");
    expect(manifest.saved).toEqual([
      {
        etag,
        path: "agents/ada/notes.md",
        sha256: await sha256Of(bytesOf("v2")),
      },
    ]);
  });

  test("a remote change does not overwrite a local edit", async () => {
    const { local, manifest, ports, remote } = setup();
    remote.put("agents/ada/notes.md", "v1");
    await runSyncIn(ports, { roots: ADA });
    const before = structuredClone(manifest.saved);
    local.put("agents/ada/notes.md", "my edit");
    remote.put("agents/ada/notes.md", "v2");

    const result = await runSyncIn(ports, { roots: ADA });

    expect(result.kept).toEqual(["agents/ada/notes.md"]);
    expect(result.pulled).toEqual([]);
    expect(textOf(local.files.get("agents/ada/notes.md"))).toBe("my edit");
    expect(manifest.saved).toEqual(before);
  });

  test("a local file with no manifest entry and the same bytes is adopted without a pull", async () => {
    const { local, manifest, ports, remote } = setup();
    const etag = remote.put("agents/ada/notes.md", "same");
    local.put("agents/ada/notes.md", "same");

    const result = await runSyncIn(ports, { roots: ADA });

    expect(result.pulled).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(remote.calls).not.toContain("write agents/ada/notes.md");
    expect(textOf(local.files.get("agents/ada/notes.md"))).toBe("same");
    expect(manifest.saved).toEqual([
      {
        etag,
        path: "agents/ada/notes.md",
        sha256: await sha256Of(bytesOf("same")),
      },
    ]);
  });

  test("a local file with no manifest entry and different bytes is kept", async () => {
    const { local, manifest, ports, remote } = setup();
    remote.put("agents/ada/notes.md", "library");
    local.put("agents/ada/notes.md", "mine");

    const result = await runSyncIn(ports, { roots: ADA });

    expect(result.kept).toEqual(["agents/ada/notes.md"]);
    expect(textOf(local.files.get("agents/ada/notes.md"))).toBe("mine");
    expect(manifest.saved).toEqual([]);
  });

  test("a manifest entry whose local file was deleted is not pulled back", async () => {
    const { local, ports, remote } = setup();
    remote.put("agents/ada/notes.md", "hello");
    await runSyncIn(ports, { roots: ADA });
    local.files.delete("agents/ada/notes.md");

    const result = await runSyncIn(ports, { roots: ADA });

    expect(result.kept).toEqual([]);
    expect(result.pulled).toEqual([]);
    expect(local.files.has("agents/ada/notes.md")).toBe(false);
  });

  test("a file over maxFileBytes is skipped and not copied", async () => {
    const { local, manifest, ports, remote } = setup();
    remote.put("agents/ada/small.md", "hi");
    remote.put("agents/ada/big.md", "x".repeat(20));

    const result = await runSyncIn(ports, { maxFileBytes: 10, roots: ADA });

    expect(result.skipped).toEqual(["agents/ada/big.md"]);
    expect(result.pulled).toEqual(["agents/ada/small.md"]);
    expect(local.files.has("agents/ada/big.md")).toBe(false);
    expect(manifest.saved.map((entry) => entry.path)).toEqual([
      "agents/ada/small.md",
    ]);
  });

  test("a file deleted in the library is removed when unedited and kept when edited", async () => {
    const { local, manifest, ports, remote } = setup();
    remote.put("agents/ada/a.md", "keep");
    remote.put("agents/ada/b.md", "gone");
    await runSyncIn(ports, { roots: ADA });
    remote.delete("agents/ada/a.md");
    remote.delete("agents/ada/b.md");
    local.put("agents/ada/a.md", "edited");

    const result = await runSyncIn(ports, { roots: ADA });

    expect(result.removed).toEqual(["agents/ada/b.md"]);
    expect(result.kept).toEqual(["agents/ada/a.md"]);
    expect(local.files.has("agents/ada/b.md")).toBe(false);
    expect(textOf(local.files.get("agents/ada/a.md"))).toBe("edited");
    expect(manifest.saved).toEqual([]);
  });

  test("conflict copies in the library are listed", async () => {
    const { ports, remote } = setup();
    remote.put("agents/ada/a.md", "base");
    remote.put("agents/ada/a.md.conflict-r1", "mine");

    const result = await runSyncIn(ports, { roots: ADA });

    expect(result.conflicts).toEqual(["agents/ada/a.md.conflict-r1"]);
  });

  test("a remote read that throws lands in failed while other files still copy", async () => {
    const { local, ports, remote } = setup();
    remote.put("agents/ada/bad.md", "bad");
    remote.put("agents/ada/good.md", "good");
    const { read } = remote;
    remote.read = (path) =>
      path === "agents/ada/bad.md"
        ? Promise.reject(new Error("boom"))
        : read(path);

    const result = await runSyncIn(ports, { roots: ADA });

    expect(result.failed).toEqual([
      { message: "boom", path: "agents/ada/bad.md" },
    ]);
    expect(result.pulled).toEqual(["agents/ada/good.md"]);
    expect(textOf(local.files.get("agents/ada/good.md"))).toBe("good");
  });

  test("a local edit made while the library file is being read is not overwritten", async () => {
    const { local, manifest, ports, remote } = setup();
    remote.put("agents/ada/notes.md", "v1");
    await runSyncIn(ports, { roots: ADA });
    remote.put("agents/ada/notes.md", "v2");
    const { read } = remote;
    remote.read = (path) => {
      local.put(path, "edited meanwhile");
      return read(path);
    };

    const result = await runSyncIn(ports, { roots: ADA });

    expect(result.kept).toEqual(["agents/ada/notes.md"]);
    expect(result.pulled).toEqual([]);
    expect(textOf(local.files.get("agents/ada/notes.md"))).toBe(
      "edited meanwhile"
    );
    expect(manifest.saved[0]?.sha256).toBe(await sha256Of(bytesOf("v1")));
  });
});
