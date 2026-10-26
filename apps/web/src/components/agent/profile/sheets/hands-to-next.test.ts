import { expect, test } from "bun:test";
import { nextHandsTo } from "./hands-to-next.ts";

const active = new Set(["b", "c", "d"]);

test("adding a target drops an archived id from the sent list", () => {
  expect(nextHandsTo(["archived", "b"], active, "c", true)).toEqual(["b", "c"]);
});

test("removing a target drops an archived id from the sent list", () => {
  expect(nextHandsTo(["archived", "b", "c"], active, "b", false)).toEqual([
    "c",
  ]);
});

test("checking an already listed target does not repeat it", () => {
  expect(nextHandsTo(["b"], active, "b", true)).toEqual(["b"]);
});
