import { describe, expect, test } from "bun:test";
import { keyState } from "./key-state";

describe("keyState", () => {
  test("reports no key when none is configured", () => {
    expect(keyState({ configured: false, hint: null, updatedAt: null })).toBe(
      "No key set"
    );
  });

  test("reports no key when configured but the hint is missing", () => {
    expect(keyState({ configured: true, hint: null, updatedAt: null })).toBe(
      "No key set"
    );
  });

  test("shows the hint and the relative time of the update", () => {
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const text = keyState({
      configured: true,
      hint: "ab12",
      updatedAt: anHourAgo,
    });
    expect(text.startsWith("Key ending in ab12, set ")).toBe(true);
    expect(text.endsWith(" ago")).toBe(true);
  });

  test("says recently when the update time is unknown", () => {
    expect(keyState({ configured: true, hint: "ab12", updatedAt: null })).toBe(
      "Key ending in ab12, set recently"
    );
  });
});
