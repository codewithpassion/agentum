import { expect, test } from "bun:test";
import { jobLine, ownerName } from "./header-logic.ts";

test("the job line is the first non-empty line of the instructions", () => {
  expect(jobLine("\n  Sort the inbox.  \nThen archive it.")).toBe(
    "Sort the inbox."
  );
});

test("no instructions means no job line", () => {
  expect(jobLine("")).toBeNull();
  expect(jobLine("  \n \n")).toBeNull();
});

test("a long first line is cut at a word and ends in an ellipsis", () => {
  const line = jobLine(`${"word ".repeat(40)}end`);
  expect(line?.endsWith("…")).toBe(true);
  expect((line ?? "").length).toBeLessThanOrEqual(121);
  expect(line).not.toContain("  ");
});

test("the owner is the owner user, or the creator when none is set", () => {
  const members = [
    { name: "Ada", userId: "u1" },
    { name: "Bo", userId: "u2" },
  ];
  expect(ownerName({ createdBy: "u1", ownerUserId: "u2" }, members)).toBe("Bo");
  expect(ownerName({ createdBy: "u1", ownerUserId: null }, members)).toBe(
    "Ada"
  );
});

test("an owner who left, or a failed member lookup, has no name", () => {
  expect(
    ownerName({ createdBy: "u9", ownerUserId: null }, [
      { name: "Ada", userId: "u1" },
    ])
  ).toBeNull();
  expect(ownerName({ createdBy: "u1", ownerUserId: null }, null)).toBeNull();
});
