import { describe, expect, test } from "bun:test";
import { sha256Of } from "./files.ts";
import { runSyncOut } from "./sync-out.ts";
import {
  bytesOf,
  createMemoryLocal,
  createMemoryManifest,
  createMemoryRemote,
  textOf,
} from "./testing.ts";
import type { SyncPorts, SyncRoot } from "./types.ts";

const ROOT = "agents/ada";
const NOTES = "agents/ada/notes.md";

const setup = () => {
  const remote = createMemoryRemote();
  const local = createMemoryLocal();
  const manifest = createMemoryManifest();
  const ports: SyncPorts = { local, manifest, remote };
  return { local, manifest, ports, remote };
};

type Ctx = ReturnType<typeof setup>;

/** A file that the last sync left in step: the same text on both sides, recorded in the manifest. */
const synced = async (ctx: Ctx, path: string, text: string) => {
  const etag = ctx.remote.put(path, text);
  ctx.local.put(path, text);
  ctx.manifest.saved.push({
    etag,
    path,
    sha256: await sha256Of(bytesOf(text)),
  });
};

const syncOut = (
  ctx: Ctx,
  runId = "r1",
  extra: { maxFileBytes?: number; roots?: SyncRoot[] } = {}
) =>
  runSyncOut(ctx.ports, {
    roots: extra.roots ?? [{ path: ROOT, mode: "write" }],
    runId,
    ...(extra.maxFileBytes === undefined
      ? {}
      : { maxFileBytes: extra.maxFileBytes }),
  });

const writesIn = (ctx: Ctx) =>
  ctx.remote.calls.filter((call) => call.startsWith("write "));

describe("runSyncOut", () => {
  test("sends an edited file with the manifest etag and records the new etag", async () => {
    const ctx = setup();
    await synced(ctx, NOTES, "v1");
    ctx.local.put(NOTES, "v2");

    const result = await syncOut(ctx);

    const remoteFile = ctx.remote.files.get(NOTES);
    expect(textOf(remoteFile?.bytes)).toBe("v2");
    expect(result.written).toEqual([NOTES]);
    expect(result.conflicts).toEqual([]);
    expect(ctx.manifest.saved).toEqual([
      {
        etag: remoteFile?.etag ?? "",
        path: NOTES,
        sha256: await sha256Of(bytesOf("v2")),
      },
    ]);

    ctx.remote.calls.length = 0;
    const second = await syncOut(ctx, "r2");
    expect(writesIn(ctx)).toEqual([]);
    expect(second.written).toEqual([]);
  });

  test("leaves an unchanged file alone", async () => {
    const ctx = setup();
    await synced(ctx, NOTES, "same");

    const result = await syncOut(ctx);

    expect(writesIn(ctx)).toEqual([]);
    expect(result.written).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  test("writes a new local file with no remote file", async () => {
    const ctx = setup();
    ctx.local.put("agents/ada/new.md", "fresh");

    const result = await syncOut(ctx);

    const remoteFile = ctx.remote.files.get("agents/ada/new.md");
    expect(textOf(remoteFile?.bytes)).toBe("fresh");
    expect(result.written).toEqual(["agents/ada/new.md"]);
    expect(ctx.manifest.saved.map((entry) => entry.path)).toEqual([
      "agents/ada/new.md",
    ]);
  });

  test("turns a changed library file into a conflict copy and keeps the library's bytes", async () => {
    const ctx = setup();
    await synced(ctx, NOTES, "base");
    ctx.local.put(NOTES, "local edit");
    ctx.remote.put(NOTES, "other writer");

    const result = await syncOut(ctx, "r1");

    const copyPath = `${NOTES}.conflict-r1`;
    expect(textOf(ctx.remote.files.get(NOTES)?.bytes)).toBe("other writer");
    expect(textOf(ctx.remote.files.get(copyPath)?.bytes)).toBe("local edit");
    expect(textOf(ctx.local.files.get(NOTES))).toBe("other writer");
    expect(textOf(ctx.local.files.get(copyPath))).toBe("local edit");
    expect(result.conflicts).toEqual([{ conflictPath: copyPath, path: NOTES }]);
    expect(result.written).toEqual([]);

    ctx.remote.calls.length = 0;
    const second = await syncOut(ctx, "r2");
    expect(writesIn(ctx)).toEqual([]);
    expect(second.conflicts).toEqual([]);
    expect(second.written).toEqual([]);
  });

  test("deletes the library file when the local delete matches the etag", async () => {
    const ctx = setup();
    await synced(ctx, NOTES, "bye");
    ctx.local.remove(NOTES);

    const result = await syncOut(ctx);

    expect(ctx.remote.files.has(NOTES)).toBe(false);
    expect(result.deleted).toEqual([NOTES]);
    expect(ctx.manifest.saved).toEqual([]);
  });

  test("keeps the library file when its etag changed since the local delete's sync", async () => {
    const ctx = setup();
    await synced(ctx, NOTES, "bye");
    ctx.remote.put(NOTES, "changed in the library");
    ctx.local.remove(NOTES);

    const result = await syncOut(ctx);

    expect(textOf(ctx.remote.files.get(NOTES)?.bytes)).toBe(
      "changed in the library"
    );
    expect(result.deleteSkipped).toEqual([NOTES]);
    expect(result.deleted).toEqual([]);
    expect(ctx.manifest.saved).toEqual([]);
  });

  test("makes a conflict copy when a new local file meets an existing library file", async () => {
    const ctx = setup();
    ctx.remote.put(NOTES, "library");
    ctx.local.put(NOTES, "mine");

    const result = await syncOut(ctx, "r1");

    expect(textOf(ctx.remote.files.get(NOTES)?.bytes)).toBe("library");
    expect(textOf(ctx.remote.files.get(`${NOTES}.conflict-r1`)?.bytes)).toBe(
      "mine"
    );
    expect(textOf(ctx.local.files.get(NOTES))).toBe("library");
    expect(result.conflicts).toEqual([
      { conflictPath: `${NOTES}.conflict-r1`, path: NOTES },
    ]);
  });

  test("moves a renamed file: deletes the old path and writes the new one", async () => {
    const ctx = setup();
    await synced(ctx, "agents/ada/old.md", "content");
    ctx.local.remove("agents/ada/old.md");
    ctx.local.put("agents/ada/new.md", "content");

    const result = await syncOut(ctx);

    expect(ctx.remote.files.has("agents/ada/old.md")).toBe(false);
    expect(textOf(ctx.remote.files.get("agents/ada/new.md")?.bytes)).toBe(
      "content"
    );
    expect(result.deleted).toEqual(["agents/ada/old.md"]);
    expect(result.written).toEqual(["agents/ada/new.md"]);
    expect(ctx.manifest.saved.map((entry) => entry.path)).toEqual([
      "agents/ada/new.md",
    ]);
  });

  test("skips a file over the size limit and does not delete its library copy", async () => {
    const ctx = setup();
    await synced(ctx, "agents/ada/big.md", "0123456789");
    ctx.local.put("agents/ada/big.md", "0123456789-edited");

    const result = await syncOut(ctx, "r1", { maxFileBytes: 5 });

    expect(result.skipped).toEqual(["agents/ada/big.md"]);
    expect(result.deleted).toEqual([]);
    expect(writesIn(ctx)).toEqual([]);
    expect(textOf(ctx.remote.files.get("agents/ada/big.md")?.bytes)).toBe(
      "0123456789"
    );
    expect(ctx.manifest.saved.map((entry) => entry.path)).toEqual([
      "agents/ada/big.md",
    ]);
  });

  test("ignores files and manifest entries outside the roots", async () => {
    const ctx = setup();
    ctx.local.put("notes/other.md", "outside");
    ctx.remote.put("other/x.md", "remote only");
    ctx.manifest.saved.push({
      etag: ctx.remote.files.get("other/x.md")?.etag ?? "",
      path: "other/x.md",
      sha256: await sha256Of(bytesOf("remote only")),
    });

    const result = await syncOut(ctx);

    expect(ctx.remote.files.has("notes/other.md")).toBe(false);
    expect(textOf(ctx.remote.files.get("other/x.md")?.bytes)).toBe(
      "remote only"
    );
    expect(
      ctx.remote.calls.filter((call) => call.startsWith("delete"))
    ).toEqual([]);
    expect(result.written).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(ctx.manifest.saved.map((entry) => entry.path)).toEqual([
      "other/x.md",
    ]);
  });

  test("records a failed write and still sends the other files", async () => {
    const ctx = setup();
    ctx.local.put("agents/ada/a.md", "a");
    ctx.local.put("agents/ada/b.md", "b");
    ctx.remote.failWrites.add("agents/ada/a.md");

    const result = await syncOut(ctx);

    expect(result.failed).toEqual([
      { message: "write agents/ada/a.md failed", path: "agents/ada/a.md" },
    ]);
    expect(result.written).toEqual(["agents/ada/b.md"]);
    expect(textOf(ctx.remote.files.get("agents/ada/b.md")?.bytes)).toBe("b");
    expect(ctx.manifest.saved.map((entry) => entry.path)).toEqual([
      "agents/ada/b.md",
    ]);
  });

  test("a file the library already holds with the same bytes is adopted, not made a conflict", async () => {
    const ctx = setup();
    // An earlier send reached the library, but its manifest save was lost.
    const etag = ctx.remote.put(NOTES, "same");
    ctx.local.put(NOTES, "same");

    const result = await syncOut(ctx);

    expect(result.conflicts).toEqual([]);
    expect([...ctx.remote.files.keys()]).toEqual([NOTES]);
    expect(ctx.manifest.saved).toEqual([
      { etag, path: NOTES, sha256: await sha256Of(bytesOf("same")) },
    ]);
  });

  test("a conflict copy whose local write fails is not recorded in the manifest", async () => {
    const ctx = setup();
    await synced(ctx, NOTES, "v1");
    ctx.remote.put(NOTES, "theirs");
    ctx.local.put(NOTES, "mine");
    ctx.local.failWrites.add(`${NOTES}.conflict-r1`);

    const result = await syncOut(ctx);

    expect(result.failed.map((failure) => failure.path)).toEqual([NOTES]);
    expect(
      ctx.manifest.saved.some((entry) => entry.path.includes(".conflict-"))
    ).toBe(false);
    // The next run must not take the copy for a local delete.
    const next = await syncOut(ctx, "r2");
    expect(next.deleted).toEqual([]);
    expect(ctx.remote.files.has(`${NOTES}.conflict-r1`)).toBe(true);
  });

  test("an edit made while a conflict is resolved stays in the local file", async () => {
    const ctx = setup();
    await synced(ctx, NOTES, "v1");
    ctx.remote.put(NOTES, "theirs");
    ctx.local.put(NOTES, "mine");
    const { read } = ctx.remote;
    ctx.remote.read = (path) => {
      ctx.local.put(NOTES, "edited again");
      return read(path);
    };

    const result = await syncOut(ctx);

    expect(result.conflicts).toHaveLength(1);
    expect(textOf(ctx.local.files.get(NOTES))).toBe("edited again");
    expect(textOf(ctx.remote.files.get(NOTES)?.bytes)).toBe("theirs");
  });

  test("a library file deleted by someone else keeps the conflict copy and sends the local file as new next time", async () => {
    const ctx = setup();
    await synced(ctx, NOTES, "v1");
    ctx.remote.files.delete(NOTES);
    ctx.local.put(NOTES, "mine");

    const first = await syncOut(ctx);
    expect(first.conflicts).toEqual([
      { conflictPath: `${NOTES}.conflict-r1`, path: NOTES },
    ]);
    expect(ctx.manifest.saved.some((entry) => entry.path === NOTES)).toBe(
      false
    );

    const second = await syncOut(ctx, "r2");
    expect(second.written).toEqual([NOTES]);
    expect(textOf(ctx.remote.files.get(NOTES)?.bytes)).toBe("mine");
  });
});

describe("read root refusals", () => {
  test("refuses edits, new files and deletes without touching the library or manifest", async () => {
    const ctx = setup();
    await synced(ctx, NOTES, "base");
    await synced(ctx, "agents/ada/gone.md", "gone");
    await synced(ctx, "agents/ada/same.md", "same");
    const before = structuredClone(ctx.manifest.saved);
    ctx.local.put(NOTES, "edited");
    ctx.local.put("agents/ada/new.md", "new");
    ctx.local.files.delete("agents/ada/gone.md");
    ctx.remote.calls.length = 0;
    const result = await syncOut(ctx, "r1", {
      roots: [{ path: "/agents/ada/", mode: "read" }],
    });
    expect(result.refused).toEqual(["agents/ada/gone.md", "agents/ada/new.md", NOTES]);
    expect(result.written).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(ctx.remote.calls).toEqual([]);
    expect(ctx.manifest.saved).toEqual(before);
    expect(textOf(ctx.local.files.get(NOTES))).toBe("edited");
  });

  test("longest root wins in both directions and read wins duplicate paths", async () => {
    const ctx = setup();
    for (const path of ["agents/ada/a", "agents/ada/sub/b", "agents/ada/sub/read/c"]) {
      ctx.local.put(path, "new");
    }
    const result = await syncOut(ctx, "r1", {
      roots: [
        { path: ROOT, mode: "read" },
        { path: "agents/ada/sub", mode: "write" },
        { path: "/agents/ada/sub/read/", mode: "read" },
        { path: "agents/ada/sub/read", mode: "write" },
      ],
    });
    expect(result.written).toEqual(["agents/ada/sub/b"]);
    expect(result.refused).toEqual(["agents/ada/a", "agents/ada/sub/read/c"]);
  });
});
