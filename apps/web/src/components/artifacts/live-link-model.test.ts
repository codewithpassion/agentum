import { expect, test } from "bun:test";
import {
  expiryText,
  type GrantLike,
  liveToolOptions,
  withoutArgumentLimits,
} from "./live-link-model.ts";

const grant = (overrides: Partial<GrantLike>): GrantLike => ({
  kind: "tool",
  status: "approved",
  target: "gmail.search",
  ...overrides,
});

test("liveToolOptions keeps approved tool grants without argument limits", () => {
  const options = liveToolOptions([
    grant({ target: "gmail.search" }),
    grant({ target: 'gmail.search#{"q":"x"}' }),
    grant({ status: "pending", target: "drive.list" }),
    grant({ status: "rejected", target: "cal.list" }),
    grant({ kind: "host", target: "api.example.com" }),
    grant({ kind: "secret", target: "KEY" }),
    grant({ target: "gmail.search" }),
    grant({ target: "docs.read" }),
  ]);
  expect(options).toEqual(["gmail.search", "docs.read"]);
});

test("withoutArgumentLimits drops # rows", () => {
  expect(withoutArgumentLimits(["a", "a#{}", "b"])).toEqual(["a", "b"]);
});

test("expiryText puts the expiry in words", () => {
  expect(expiryText("7d", "")).toBe("This link expires in 7 days.");
  expect(expiryText("1d", "")).toBe("This link expires in 1 day.");
  expect(expiryText("never", "")).toBe("This link never expires.");
  expect(expiryText("date", "2026-12-24")).toBe(
    "This link expires on 24 Dec 2026."
  );
  expect(expiryText("date", "")).toBe(
    "This link expires on the date you pick."
  );
});
