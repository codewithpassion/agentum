import { describe, expect, test } from "bun:test";
import { parseExpiresIn } from "./duration";

describe("parseExpiresIn", () => {
  test("nothing means no expiry, which is the default", () => {
    expect(parseExpiresIn(undefined)).toEqual({ ok: true, seconds: null });
    expect(parseExpiresIn(null)).toEqual({ ok: true, seconds: null });
    expect(parseExpiresIn("")).toEqual({ ok: true, seconds: null });
  });

  test("reads the durations a model actually writes", () => {
    expect(parseExpiresIn("30m")).toEqual({ ok: true, seconds: 1800 });
    expect(parseExpiresIn("2 hours")).toEqual({ ok: true, seconds: 7200 });
    expect(parseExpiresIn("1d")).toEqual({ ok: true, seconds: 86_400 });
    expect(parseExpiresIn("90s")).toEqual({ ok: true, seconds: 90 });
    // Bare numbers are seconds, string or not.
    expect(parseExpiresIn("600")).toEqual({ ok: true, seconds: 600 });
    expect(parseExpiresIn(600)).toEqual({ ok: true, seconds: 600 });
  });

  test("refuses an expiry nobody could answer, and one nobody would wait for", () => {
    expect(parseExpiresIn("30s").ok).toBe(false);
    expect(parseExpiresIn("8d").ok).toBe(false);
    expect(parseExpiresIn("soon").ok).toBe(false);
    expect(parseExpiresIn({}).ok).toBe(false);
  });
});
