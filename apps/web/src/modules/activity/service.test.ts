import { describe, expect, test } from "bun:test";
import { decodeActivityCursor, encodeActivityCursor } from "./service";

describe("activity cursors", () => {
  test("round-trip a row", () => {
    const row = { createdAt: new Date(1_700_000_000_000), id: "abc-123" };
    expect(decodeActivityCursor(encodeActivityCursor(row))).toEqual({
      createdAt: 1_700_000_000_000,
      id: "abc-123",
    });
  });

  test("survive an id containing the separator", () => {
    const row = { createdAt: new Date(42), id: "a:b:c" };
    expect(decodeActivityCursor(encodeActivityCursor(row))).toEqual({
      createdAt: 42,
      id: "a:b:c",
    });
  });

  test("treat a missing or malformed cursor as no cursor", () => {
    expect(decodeActivityCursor(undefined)).toBeUndefined();
    expect(decodeActivityCursor("")).toBeUndefined();
    expect(decodeActivityCursor("nonsense")).toBeUndefined();
    expect(decodeActivityCursor(":abc")).toBeUndefined();
    expect(decodeActivityCursor("123:")).toBeUndefined();
  });
});
