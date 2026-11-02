/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
  pickerPath,
  pickerTarget,
  safeRedirectPath,
} from "./picker-redirect.ts";

describe("safeRedirectPath", () => {
  test("keeps a path on this origin, query included", () => {
    expect(safeRedirectPath("/agents?tab=a#x")).toBe("/agents?tab=a#x");
  });

  test.each([
    undefined,
    "",
    "agents",
    "//evil.example",
    "https://evil.example/",
    "/\\evil.example",
    "javascript:alert(1)",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r/evil.example",
  ])("rejects %p", (value) => {
    expect(safeRedirectPath(value)).toBeUndefined();
  });
});

describe("pickerTarget", () => {
  test("goes to the page asked for", () => {
    expect(pickerTarget("/agents")).toBe("/agents");
  });

  test("falls back to /desk", () => {
    expect(pickerTarget(undefined)).toBe("/desk");
    expect(pickerTarget("//evil.example")).toBe("/desk");
  });
});

describe("pickerPath", () => {
  test("carries the page the person was on", () => {
    expect(pickerPath("/agents?tab=a")).toBe(
      "/choose-organization?redirect=%2Fagents%3Ftab%3Da"
    );
  });

  test("carries nothing for the picker itself or an unsafe path", () => {
    expect(pickerPath("/choose-organization?redirect=%2Fx")).toBe(
      "/choose-organization"
    );
    expect(pickerPath("//evil.example")).toBe("/choose-organization");
  });
});
