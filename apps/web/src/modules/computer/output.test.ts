import { describe, expect, test } from "bun:test";
import { truncateText, withTruncationNote } from "./output";

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
