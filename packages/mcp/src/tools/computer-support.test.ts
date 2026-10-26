import { describe, expect, test } from "bun:test";
import {
  MAX_FILE_BYTES,
  truncateText,
  validateContent,
  validatePath,
  withTruncationNote,
} from "./computer-support";

describe("truncateText", () => {
  test("leaves text under the cap alone", () => {
    expect(truncateText("hello", 100)).toEqual({
      originalBytes: 5,
      text: "hello",
      truncated: false,
    });
  });

  test("keeps the head and reports the original size", () => {
    const result = truncateText("abcdefghij", 4);
    expect(result.text).toBe("abcd");
    expect(result.originalBytes).toBe(10);
    expect(result.truncated).toBe(true);
  });

  test("counts bytes rather than characters", () => {
    // "é" is two bytes, so eight characters are sixteen bytes.
    const result = truncateText("é".repeat(8), 10);
    expect(result.originalBytes).toBe(16);
    expect(result.text).toBe("é".repeat(5));
  });

  test("does not leave half a multi-byte character behind", () => {
    // Cutting at 3 bytes lands inside the second "é".
    const result = truncateText("éé", 3);
    expect(result.text).toBe("é");
    expect(result.text).not.toContain("�");
  });

  test("keeps a replacement character that was in the input", () => {
    const result = truncateText("�abc", 100);
    expect(result.text).toBe("�abc");
  });
});

describe("withTruncationNote", () => {
  test("adds nothing when the text is complete", () => {
    expect(withTruncationNote(truncateText("hello", 100))).toBe("hello");
  });

  test("says how much was shown and how much there was", () => {
    const note = withTruncationNote(truncateText("abcdefghij", 4));
    expect(note).toBe("abcd\n[truncated: showing the first 4 of 10 bytes]");
  });
});

describe("validatePath", () => {
  test("accepts an absolute path", () => {
    expect(validatePath("/notes/plan.md")).toEqual({
      ok: true,
      path: "/notes/plan.md",
    });
  });

  test("accepts the root", () => {
    expect(validatePath("/")).toEqual({ ok: true, path: "/" });
  });

  test("collapses repeated slashes", () => {
    expect(validatePath("//notes///plan.md")).toEqual({
      ok: true,
      path: "/notes/plan.md",
    });
  });

  test("drops a trailing slash so one directory has one name", () => {
    expect(validatePath("/notes/")).toEqual({ ok: true, path: "/notes" });
  });

  test("rejects a relative path", () => {
    const result = validatePath("notes/plan.md");
    expect(result.ok).toBe(false);
  });

  test("rejects parent traversal anywhere in the path", () => {
    expect(validatePath("/notes/../../etc/passwd").ok).toBe(false);
    expect(validatePath("/..").ok).toBe(false);
    expect(validatePath("/a/../b").ok).toBe(false);
  });

  test("rejects a bare current-directory segment", () => {
    expect(validatePath("/notes/./plan.md").ok).toBe(false);
  });

  test("does not mistake a filename that starts with dots for traversal", () => {
    expect(validatePath("/notes/..plan.md").ok).toBe(true);
    expect(validatePath("/.config/settings.json").ok).toBe(true);
  });

  test("rejects null bytes", () => {
    expect(validatePath("/notes/plan\0.md").ok).toBe(false);
  });

  test("rejects an over-long path", () => {
    expect(validatePath(`/${"a".repeat(2000)}`).ok).toBe(false);
  });

  test("rejects a non-string", () => {
    expect(validatePath(undefined).ok).toBe(false);
    expect(validatePath("").ok).toBe(false);
  });
});

describe("validateContent", () => {
  test("accepts text under the cap", () => {
    expect(validateContent("hello")).toEqual({ content: "hello", ok: true });
  });

  test("measures bytes, not characters", () => {
    // Four bytes per emoji: 3 characters would pass a length check.
    expect(validateContent("😀😀😀", 8).ok).toBe(false);
    expect(validateContent("😀😀", 8).ok).toBe(true);
  });

  test("rejects content over the file cap", () => {
    const result = validateContent("a".repeat(MAX_FILE_BYTES + 1));
    expect(result.ok).toBe(false);
  });

  test("rejects a non-string", () => {
    expect(validateContent(42).ok).toBe(false);
  });
});
