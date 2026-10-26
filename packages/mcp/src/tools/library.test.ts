import { expect, test } from "bun:test";
import { ToolError } from "../result";
import { textOf } from "../testing";
import { callTool, fakePorts } from "./library-wiki.test-helpers";

const entry = {
  etag: "e1",
  kind: "file" as const,
  mtime: "2026-10-27T00:00:00Z",
  path: "agents/ops/tasks/t1/file",
  size: 4,
  updatedBy: { id: "agent", kind: "agent" as const },
};

test("binary bytes round trip through base64 and forward ifEtag", async () => {
  let bytes = new Uint8Array();
  const ports = fakePorts({
    libraryRead: (input) => {
      expect(input).toEqual({ path: entry.path });
      return Promise.resolve({ bytes, entry });
    },
    libraryWrite: (input) => {
      expect(input.path).toBe(entry.path);
      expect(input.ifEtag).toBe("e0");
      bytes = new Uint8Array(input.bytes);
      return Promise.resolve(entry);
    },
  });
  const written = await callTool(ports, "library_write", {
    content: "AP+AQQ==",
    encoding: "base64",
    ifEtag: "e0",
    path: entry.path,
  });
  expect(written.isError).toBeFalsy();
  expect(written.structuredContent).toEqual({ entry });
  expect(bytes).toEqual(new Uint8Array([0, 255, 128, 65]));
  const read = await callTool(ports, "library_read", { path: entry.path });
  expect(read.structuredContent).toEqual({
    content: "AP+AQQ==",
    encoding: "base64",
    entry,
  });
  expect(textOf(read)).toContain("AP+AQQ==");
});

test("text writes default to UTF-8 and text reads preserve Unicode and BOM", async () => {
  const content = "\ufeffHello 🌊";
  const ports = fakePorts({
    libraryRead: () =>
      Promise.resolve({ bytes: new TextEncoder().encode(content), entry }),
    libraryWrite: (input) => {
      expect(input.bytes).toEqual(new TextEncoder().encode(content));
      expect(input.ifEtag).toBeUndefined();
      return Promise.resolve(entry);
    },
  });
  expect(
    (await callTool(ports, "library_write", { content, path: entry.path }))
      .isError
  ).toBeFalsy();
  expect(
    (await callTool(ports, "library_read", { path: entry.path }))
      .structuredContent
  ).toEqual({ content, encoding: "text", entry });
});

test("lists root by default and forwards directory and version paths", async () => {
  const dirs: string[] = [];
  const versions = [
    {
      authorId: "agent",
      authorKind: "agent",
      createdAt: entry.mtime,
      etag: "e1",
      id: "v1",
      op: "write" as const,
      path: entry.path,
      runId: "run",
      sha256: "hash",
      size: 4,
      version: 1,
    },
  ];
  const ports = fakePorts({
    libraryList: ({ dir }) => {
      dirs.push(dir);
      return Promise.resolve([entry]);
    },
    libraryVersions: ({ path }) => {
      expect(path).toBe(entry.path);
      return Promise.resolve(versions);
    },
  });
  expect((await callTool(ports, "library_list", {})).structuredContent).toEqual(
    { entries: [entry] }
  );
  await callTool(ports, "library_list", { dir: "agents/ops/tasks/t1" });
  expect(dirs).toEqual(["", "agents/ops/tasks/t1"]);
  expect(
    (await callTool(ports, "library_versions", { path: entry.path }))
      .structuredContent
  ).toEqual({ versions });
});

test("etag conflicts and refused paths retain actionable safe messages", async () => {
  const conflict = await callTool(
    fakePorts({
      libraryWrite: () =>
        Promise.reject(
          new ToolError("conflict", "The file changed since it was read")
        ),
    }),
    "library_write",
    { content: "new", ifEtag: "stale", path: entry.path }
  );
  expect(conflict.isError).toBe(true);
  expect(textOf(conflict)).toContain(
    "conflict: The file changed since it was read. Call library_read"
  );
  expect(textOf(conflict)).toContain("ifEtag");
  const refused = await callTool(
    fakePorts({
      libraryRead: () =>
        Promise.reject(
          new ToolError("forbidden", "Path is outside your library access.")
        ),
    }),
    "library_read",
    { path: "agents/other/private" }
  );
  expect(refused.isError).toBe(true);
  expect(textOf(refused)).toContain("forbidden: Path is outside");
});

test("a base64 write near the 10 MB limit round trips", async () => {
  const size = 10 * 1024 * 1024;
  const bytes = new Uint8Array(size).map((_, index) => index % 251);
  const written: Uint8Array[] = [];
  const result = await callTool(
    fakePorts({
      libraryWrite: (input) => {
        written.push(input.bytes);
        return Promise.resolve(entry);
      },
    }),
    "library_write",
    {
      content: Buffer.from(bytes).toString("base64"),
      encoding: "base64",
      path: entry.path,
    }
  );
  expect(result.isError).toBeUndefined();
  expect(written[0]).toEqual(bytes);
});

test("malformed encodings and extra arguments fail before calling ports", async () => {
  const calls: unknown[] = [];
  const ports = fakePorts({
    libraryWrite: (input) => {
      calls.push(input);
      return Promise.resolve(entry);
    },
  });
  await Promise.all(
    [
      { content: "%%%", encoding: "base64" },
      { content: "abc", encoding: "hex" },
      { content: "ok", principal: "other" },
    ].map(async (args) => {
      expect(
        (await callTool(ports, "library_write", { path: entry.path, ...args }))
          .isError
      ).toBe(true);
    })
  );
  expect(calls).toEqual([]);
});

for (const bytes of [
  new Uint8Array([255, 128]),
  new Uint8Array([65, 0]),
  new Uint8Array(),
]) {
  test(`read preserves bytes ${bytes.join(",")} with the documented encoding rule`, async () => {
    const result = await callTool(
      fakePorts({ libraryRead: () => Promise.resolve({ bytes, entry }) }),
      "library_read",
      { path: entry.path }
    );
    expect(result.structuredContent).toEqual({
      content: bytes.length ? btoa(String.fromCharCode(...bytes)) : "",
      encoding: bytes.length ? "base64" : "text",
      entry,
    });
  });
}

test("file size limit counts UTF-8 bytes before calling the write port", async () => {
  let called = false;
  const result = await callTool(
    fakePorts({
      libraryWrite: () => {
        called = true;
        return Promise.resolve(entry);
      },
    }),
    "library_write",
    { content: "🌊".repeat((10 * 1024 * 1024) / 4 + 1), path: entry.path }
  );
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("10 MB");
  expect(called).toBe(false);
});
