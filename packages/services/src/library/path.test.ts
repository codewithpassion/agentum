import { expect, test } from "bun:test";
import { ancestorsOf, normalizePath, parentOf } from "./path.ts";

test("paths lose leading, doubled and dot segments", () => {
  expect(normalizePath("/a//b/./c.md")).toBe("a/b/c.md");
  expect(normalizePath("a/b/../c")).toBe("a/c");
  expect(normalizePath("/")).toBe("");
  expect(normalizePath("")).toBe("");
});

test("a .. past the root is refused", () => {
  for (const path of ["..", "../a", "a/../../b", "/../a"]) {
    expect(() => normalizePath(path)).toThrow("Path leaves the library");
  }
});

test("control characters are refused", () => {
  for (const path of ["a\u0000b", "a\nb", "a\tb", "\u007fa"]) {
    expect(() => normalizePath(path)).toThrow("control characters");
  }
});

test("512 bytes and 20 segments are the limits", () => {
  expect(normalizePath("a".repeat(512))).toHaveLength(512);
  expect(() => normalizePath("a".repeat(513))).toThrow("512 bytes");
  // Two bytes per character: 256 characters fit, 257 do not.
  expect(() => normalizePath("é".repeat(256))).not.toThrow();
  expect(() => normalizePath("é".repeat(257))).toThrow("512 bytes");
  expect(() => normalizePath(new Array(20).fill("a").join("/"))).not.toThrow();
  expect(() => normalizePath(new Array(21).fill("a").join("/"))).toThrow(
    "20 segments"
  );
});

test("parentOf and ancestorsOf", () => {
  expect(parentOf("a/b/c")).toBe("a/b");
  expect(parentOf("a")).toBe("");
  expect(ancestorsOf("a/b/c")).toEqual(["a", "a/b"]);
  expect(ancestorsOf("a")).toEqual([]);
});
