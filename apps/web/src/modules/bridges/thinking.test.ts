import { describe, expect, test } from "bun:test";
import { cleanThinkingLine } from "./thinking";

/**
 * The status line is decoration on somebody else's reply, so the bar is not
 * "make the model's answer usable" - it is "show the plain fallback rather
 * than anything odd".
 */

const FALLBACK = "Thinking…";

describe("cleanThinkingLine", () => {
  test("keeps a line that reads as a status", () => {
    expect(cleanThinkingLine("Checking the deploy history")).toBe(
      "Checking the deploy history"
    );
  });

  test("unwraps a quoted line", () => {
    expect(cleanThinkingLine('"Reading through the thread"')).toBe(
      "Reading through the thread"
    );
    expect(cleanThinkingLine("`Looking that up`")).toBe("Looking that up");
  });

  test("takes the first line when the model added more", () => {
    expect(cleanThinkingLine("Checking the logs\nThen I will answer.")).toBe(
      "Checking the logs"
    );
  });

  test("falls back rather than showing a paragraph", () => {
    // A model that answered the message instead of naming the work.
    expect(cleanThinkingLine("x".repeat(200))).toBe(FALLBACK);
  });

  test("falls back when there was no answer at all", () => {
    expect(cleanThinkingLine(null)).toBe(FALLBACK);
    expect(cleanThinkingLine("")).toBe(FALLBACK);
    expect(cleanThinkingLine("   ")).toBe(FALLBACK);
  });
});
