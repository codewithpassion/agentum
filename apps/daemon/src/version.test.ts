import { expect, test } from "bun:test";
import { resolveVersion } from "./version.ts";

test("an embedded version wins over the package version", () => {
  expect(resolveVersion("0.1.0+abc1234", "0.1.0")).toBe("0.1.0+abc1234");
});

test("without a define the package version stands", () => {
  expect(resolveVersion(undefined, "0.1.0")).toBe("0.1.0");
  expect(resolveVersion("", "0.1.0")).toBe("0.1.0");
});
