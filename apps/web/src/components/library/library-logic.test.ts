import { expect, test } from "bun:test";
import { TRPCClientError } from "@trpc/client";
import {
  baseName,
  breadcrumbs,
  downloadUrl,
  formatMtime,
  formatSize,
  isConflict,
  joinPath,
  lineDiff,
  MAX_DIFF_CELLS,
  parentDir,
  remapPath,
} from "./library-logic.ts";

test("paths join and split at the root and below it", () => {
  expect(joinPath("", "a.md")).toBe("a.md");
  expect(joinPath("docs/notes", "a.md")).toBe("docs/notes/a.md");
  expect(parentDir("a.md")).toBe("");
  expect(parentDir("docs/notes/a.md")).toBe("docs/notes");
  expect(parentDir("docs")).toBe("");
  expect(parentDir("a/b")).toBe("a");
  expect(baseName("docs/notes/a.md")).toBe("a.md");
  expect(baseName("a.md")).toBe("a.md");
});

test("breadcrumbs start at the root and add one per folder", () => {
  expect(breadcrumbs("")).toEqual([{ name: "Library", path: "" }]);
  expect(breadcrumbs("docs/notes")).toEqual([
    { name: "Library", path: "" },
    { name: "docs", path: "docs" },
    { name: "notes", path: "docs/notes" },
  ]);
});

test("sizes and times read the same everywhere", () => {
  expect(formatSize(0)).toBe("0 B");
  expect(formatSize(1023)).toBe("1023 B");
  expect(formatSize(1536)).toBe("1.5 KB");
  expect(formatSize(10 * 1024 * 1024)).toBe("10.0 MB");
  expect(formatMtime("2026-02-02T12:34:56.000Z")).toBe("2026-02-02 12:34 UTC");
});

test("a CONFLICT from tRPC is a conflict and nothing else is", () => {
  const conflict = TRPCClientError.from({
    error: {
      code: -32_009,
      data: { code: "CONFLICT", httpStatus: 409 },
      message: "The file changed since it was read",
    },
  });
  expect(isConflict(conflict)).toBe(true);
  expect(isConflict(new Error("CONFLICT"))).toBe(false);
});

test("the download URL encodes the path", () => {
  expect(downloadUrl("my docs/a&b.txt")).toBe(
    "/api/library/download?path=my%20docs%2Fa%26b.txt"
  );
});

test("a line diff of identical text is all same lines", () => {
  expect(lineDiff("a\nb\n", "a\nb\n")).toEqual([
    { kind: "same", text: "a" },
    { kind: "same", text: "b" },
  ]);
});

test("a line diff shows an inserted line between the same lines", () => {
  expect(lineDiff("a\nc\n", "a\nb\nc\n")).toEqual([
    { kind: "same", text: "a" },
    { kind: "add", text: "b" },
    { kind: "same", text: "c" },
  ]);
});

test("a line diff shows a deleted line between the same lines", () => {
  expect(lineDiff("a\nb\nc\n", "a\nc\n")).toEqual([
    { kind: "same", text: "a" },
    { kind: "del", text: "b" },
    { kind: "same", text: "c" },
  ]);
});

test("a changed line is a del followed by an add", () => {
  expect(lineDiff("a\nold\nc\n", "a\nnew\nc\n")).toEqual([
    { kind: "same", text: "a" },
    { kind: "del", text: "old" },
    { kind: "add", text: "new" },
    { kind: "same", text: "c" },
  ]);
});

test("a line diff from empty text adds every line", () => {
  expect(lineDiff("", "a\nb\n")).toEqual([
    { kind: "add", text: "a" },
    { kind: "add", text: "b" },
  ]);
});

test("a line diff to empty text deletes every line", () => {
  expect(lineDiff("a\nb\n", "")).toEqual([
    { kind: "del", text: "a" },
    { kind: "del", text: "b" },
  ]);
});

test("a trailing newline does not add an empty line", () => {
  expect(lineDiff("a", "a\n")).toEqual([{ kind: "same", text: "a" }]);
  expect(lineDiff("a\n", "a\nb")).toEqual([
    { kind: "same", text: "a" },
    { kind: "add", text: "b" },
  ]);
  expect(lineDiff("\n", "")).toEqual([{ kind: "del", text: "" }]);
});

test("a line diff finds the longest common lines when edits interleave", () => {
  expect(lineDiff("a\nx\nb\ny\nc\n", "a\nb\nz\nc\n")).toEqual([
    { kind: "same", text: "a" },
    { kind: "del", text: "x" },
    { kind: "same", text: "b" },
    { kind: "del", text: "y" },
    { kind: "add", text: "z" },
    { kind: "same", text: "c" },
  ]);
});

test("a moved folder carries the paths below it and nothing else", () => {
  expect(remapPath("docs", "docs", "notes")).toBe("notes");
  expect(remapPath("docs/a.md", "docs", "notes")).toBe("notes/a.md");
  expect(remapPath("docs2/a.md", "docs", "notes")).toBe("docs2/a.md");
  expect(remapPath("a.md", "a.md", "b.md")).toBe("b.md");
});

const numbered = (prefix: string, count: number): string =>
  Array.from({ length: count }, (_, i) => `${prefix}${i}`).join("\n");

test("two huge texts with nothing in common fall back to deletes then adds", () => {
  const before = numbered("a", 20_000);
  const after = numbered("b", 20_000);
  expect(20_001 * 20_001).toBeGreaterThan(MAX_DIFF_CELLS);
  const diff = lineDiff(before, after);
  expect(diff).toHaveLength(40_000);
  expect(diff.slice(0, 20_000).every((line) => line.kind === "del")).toBe(true);
  expect(diff.slice(20_000).every((line) => line.kind === "add")).toBe(true);
  expect(diff[0]).toEqual({ kind: "del", text: "a0" });
  expect(diff[39_999]).toEqual({ kind: "add", text: "b19999" });
});

test("the fallback still trims the common head and tail", () => {
  const diff = lineDiff(
    `top\n${numbered("a", 5000)}\nend`,
    `top\n${numbered("b", 5000)}\nend`
  );
  expect(diff[0]).toEqual({ kind: "same", text: "top" });
  expect(diff.at(-1)).toEqual({ kind: "same", text: "end" });
  expect(diff).toHaveLength(10_002);
});

test("a small middle is still compared line by line", () => {
  const diff = lineDiff("x\nkeep\ny", "p\nkeep\nq");
  expect(diff).toEqual([
    { kind: "del", text: "x" },
    { kind: "add", text: "p" },
    { kind: "same", text: "keep" },
    { kind: "del", text: "y" },
    { kind: "add", text: "q" },
  ]);
});
