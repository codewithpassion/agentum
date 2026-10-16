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
  parentDir,
} from "./library-logic.ts";

test("paths join and split at the root and below it", () => {
  expect(joinPath("", "a.md")).toBe("a.md");
  expect(joinPath("docs/notes", "a.md")).toBe("docs/notes/a.md");
  expect(parentDir("a.md")).toBe("");
  expect(parentDir("docs/notes/a.md")).toBe("docs/notes");
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
