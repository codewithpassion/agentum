import { describe, expect, test } from "bun:test";
import { checkArgLimits } from "./arg-limits.ts";

const row = (limits: unknown) => `xero/list_invoices#${JSON.stringify(limits)}`;

describe("checkArgLimits", () => {
  test("no rows means no check", () => {
    expect(checkArgLimits(null, [])).toBeNull();
    expect(checkArgLimits("anything", [])).toBeNull();
  });

  test("max and min need a finite number within the bound", () => {
    const rows = [row({ n: { max: 5, min: 1 } })];
    expect(checkArgLimits({ n: 1 }, rows)).toBeNull();
    expect(checkArgLimits({ n: 5 }, rows)).toBeNull();
    expect(checkArgLimits({ n: 6 }, rows)).toContain('"n"');
    expect(checkArgLimits({ n: 0 }, rows)).toContain('"n"');
    expect(checkArgLimits({ n: "3" }, rows)).toContain('"n"');
    expect(checkArgLimits({ n: Number.NaN }, rows)).toContain('"n"');
    expect(checkArgLimits({ n: Number.POSITIVE_INFINITY }, rows)).toContain(
      '"n"'
    );
  });

  test("a min of zero still bounds", () => {
    expect(
      checkArgLimits({ since: -1 }, [row({ since: { min: 0 } })])
    ).toContain('"since"');
    expect(
      checkArgLimits({ since: 0 }, [row({ since: { min: 0 } })])
    ).toBeNull();
  });

  test("enum uses strict equality", () => {
    const rows = [row({ status: { enum: ["paid", "open"] } })];
    expect(checkArgLimits({ status: "paid" }, rows)).toBeNull();
    expect(checkArgLimits({ status: "void" }, rows)).toContain('"status"');
    expect(checkArgLimits({ status: ["paid"] }, rows)).toContain('"status"');
    expect(
      checkArgLimits({ flag: 1 }, [row({ flag: { enum: [true] } })])
    ).toContain('"flag"');
    expect(
      checkArgLimits({ flag: true }, [row({ flag: { enum: [true] } })])
    ).toBeNull();
  });

  test("maxLength needs a string of at most that length", () => {
    const rows = [row({ q: { maxLength: 3 } })];
    expect(checkArgLimits({ q: "abc" }, rows)).toBeNull();
    expect(checkArgLimits({ q: "abcd" }, rows)).toContain('"q"');
    expect(checkArgLimits({ q: 12 }, rows)).toContain('"q"');
  });

  test("a limited argument must be present, others are not checked", () => {
    const rows = [row({ q: { maxLength: 3 } })];
    expect(checkArgLimits({}, rows)).toContain('"q"');
    expect(checkArgLimits({ other: 10_000, q: "ab" }, rows)).toBeNull();
  });

  test("a non-object args is a violation when a limit applies", () => {
    const rows = [row({ q: { maxLength: 3 } })];
    for (const args of [null, undefined, [], "q", 4]) {
      expect(checkArgLimits(args, rows)).not.toBeNull();
    }
    expect(checkArgLimits(null, [row({})])).toBeNull();
  });

  test("the reason never echoes the value", () => {
    const secret = "very-secret-value-123";
    const reasons = [
      checkArgLimits({ q: secret }, [row({ q: { maxLength: 3 } })]),
      checkArgLimits({ q: secret }, [row({ q: { enum: ["a"] } })]),
      checkArgLimits({ q: secret }, [row({ q: { max: 3 } })]),
    ];
    for (const reason of reasons) {
      expect(reason).not.toBeNull();
      expect(reason).not.toContain(secret);
    }
  });

  test("bad JSON or a wrong shape refuses", () => {
    for (const target of [
      "xero/list_invoices#{nope",
      "xero/list_invoices#[1]",
      "xero/list_invoices#null",
      row({ q: "text" }),
      row({ q: { max: "5" } }),
      row({ q: { enum: [{}] } }),
      row({ q: { unknown: 1 } }),
    ]) {
      expect(checkArgLimits({ q: 1 }, [target])).not.toBeNull();
    }
  });

  test("several rows must all pass", () => {
    const rows = [row({ a: { max: 5 } }), row({ b: { max: 5 } })];
    expect(checkArgLimits({ a: 1, b: 1 }, rows)).toBeNull();
    expect(checkArgLimits({ a: 1, b: 9 }, rows)).toContain('"b"');
    expect(checkArgLimits({ a: 9, b: 1 }, rows)).toContain('"a"');
  });
});
