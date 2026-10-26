import { expect, test } from "bun:test";
import { ToolError } from "../result";
import { textOf } from "../testing";
import { callTool, fakePorts } from "./library-wiki.test-helpers";

const entry = { etag: "e1", kind: "file" as const, mtime: "2026-10-27T00:00:00Z", path: "tasks/t1/file", size: 4, updatedBy: { id: "agent", kind: "agent" as const } };

test("binary bytes round trip through base64 and forward ifEtag", async () => {
  let bytes = new Uint8Array();
  const ports = fakePorts({
    libraryWrite: (input) => { expect(input.path).toBe(entry.path); expect(input.ifEtag).toBe("e0"); bytes = new Uint8Array(input.bytes); return Promise.resolve(entry); },
    libraryRead: (input) => { expect(input).toEqual({ path: entry.path }); return Promise.resolve({ bytes, entry }); },
  });
  const written = await callTool(ports, "library_write", { path: entry.path, content: "AP+AQQ==", encoding: "base64", ifEtag: "e0" });
  expect(written.isError).toBeFalsy();
  expect(written.structuredContent).toEqual({ entry });
  expect(bytes).toEqual(new Uint8Array([0, 255, 128, 65]));
  const read = await callTool(ports, "library_read", { path: entry.path });
  expect(read.structuredContent).toEqual({ entry, encoding: "base64", content: "AP+AQQ==" });
  expect(textOf(read)).toContain("AP+AQQ==");
});

test("text writes default to UTF-8 and text reads preserve Unicode and BOM", async () => {
  const content = "\ufeffHello 🌊";
  const ports = fakePorts({
    libraryWrite: (input) => { expect(input.bytes).toEqual(new TextEncoder().encode(content)); expect(input.ifEtag).toBeUndefined(); return Promise.resolve(entry); },
    libraryRead: () => Promise.resolve({ bytes: new TextEncoder().encode(content), entry }),
  });
  expect((await callTool(ports, "library_write", { path: entry.path, content })).isError).toBeFalsy();
  expect((await callTool(ports, "library_read", { path: entry.path })).structuredContent).toEqual({ entry, encoding: "text", content });
});

test("lists root by default and forwards directory and version paths", async () => {
  const dirs: string[] = [];
  const versions = [{ id: "v1", version: 1, path: entry.path, etag: "e1", size: 4, createdAt: entry.mtime, authorId: "agent", authorKind: "agent", op: "write" as const, runId: "run", sha256: "hash" }];
  const ports = fakePorts({ libraryList: ({ dir }) => { dirs.push(dir); return Promise.resolve([entry]); }, libraryVersions: ({ path }) => { expect(path).toBe(entry.path); return Promise.resolve(versions); } });
  expect((await callTool(ports, "library_list", {})).structuredContent).toEqual({ entries: [entry] });
  await callTool(ports, "library_list", { dir: "tasks/t1" });
  expect(dirs).toEqual(["", "tasks/t1"]);
  expect((await callTool(ports, "library_versions", { path: entry.path })).structuredContent).toEqual({ versions });
});

test("etag conflicts and refused paths retain actionable safe messages", async () => {
  const conflict = await callTool(fakePorts({ libraryWrite: () => Promise.reject(new ToolError("conflict", "File changed; read library_read again before retrying with its etag.")) }), "library_write", { path: entry.path, content: "new", ifEtag: "stale" });
  expect(conflict.isError).toBe(true);
  expect(textOf(conflict)).toContain("conflict: File changed");
  const refused = await callTool(fakePorts({ libraryRead: () => Promise.reject(new ToolError("forbidden", "Path is outside your library access.")) }), "library_read", { path: "agents/other/private" });
  expect(refused.isError).toBe(true);
  expect(textOf(refused)).toContain("forbidden: Path is outside");
});

test("malformed encodings and extra arguments fail before calling ports", async () => {
  for (const args of [{ content: "%%%", encoding: "base64" }, { content: "abc", encoding: "hex" }, { content: "ok", principal: "other" }]) {
    expect((await callTool(fakePorts(), "library_write", { path: entry.path, ...args })).isError).toBe(true);
  }
});
