import { describe, expect, test } from "bun:test";
import { ToolError } from "@repo/mcp/result";
import { base64ToBytes, bytesToBase64 } from "./base64.ts";

const large = (size: number) =>
  Uint8Array.from(
    { length: size },
    (_, i) => (i * 31 + Math.floor(i / 256)) % 256
  );

describe("base64 round trip", () => {
  test("empty input", () => {
    expect(bytesToBase64(new Uint8Array())).toBe("");
    expect(base64ToBytes("")).toEqual(new Uint8Array());
  });

  test("binary bytes, every value", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  test("known encoding", () => {
    expect(bytesToBase64(new TextEncoder().encode("Man"))).toBe("TWFu");
    expect(bytesToBase64(new TextEncoder().encode("Ma"))).toBe("TWE=");
  });

  test("large input beyond the call stack chunk size", () => {
    const bytes = large(10 * 1024 * 1024);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  test("ignores line breaks in the input", () => {
    expect(base64ToBytes("TWFu\nTWE=\r\n")).toEqual(
      new TextEncoder().encode("ManMa")
    );
  });
});

describe("base64ToBytes rejects bad input", () => {
  test.each([
    ["a character outside the alphabet", "TW!u"],
    ["a length that is not a multiple of four", "TWFuT"],
    ["padding in the middle", "TW=u"],
    ["too much padding", "TWF==="],
    ["unpadded final group", "TWE"],
  ])("%s", (_, text) => {
    expect(() => base64ToBytes(text)).toThrow(ToolError);
    expect(() => base64ToBytes(text)).toThrow("is not valid base64");
  });

  test("reports the validation code", () => {
    try {
      base64ToBytes("***");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("validation");
    }
  });
});
