import { expect, test } from "bun:test";
import {
  heldCountText,
  inCountText,
  type MailCount,
  mailRowsFor,
} from "./mail-strip-logic.ts";

const ada: MailCount = {
  address: "ada@agents.example",
  agentId: "agt_1",
  held: 0,
  in: 3,
};
const bob: MailCount = {
  address: "bob@agents.example",
  agentId: "agt_2",
  held: 2,
  in: 1,
};
const rows = [ada, bob];

test("no selected agent shows every row", () => {
  expect(mailRowsFor(rows, undefined)).toEqual(rows);
});

test("a selected agent shows only its own rows", () => {
  expect(mailRowsFor(rows, "agt_2")).toEqual([bob]);
});

test("an agent with no mail today has no rows", () => {
  expect(mailRowsFor(rows, "agt_9")).toEqual([]);
});

test("an empty list stays empty", () => {
  expect(mailRowsFor([], undefined)).toEqual([]);
});

test("the in count and hold count read as short text", () => {
  expect(inCountText(0)).toBe("0 in");
  expect(inCountText(1)).toBe("1 in");
  expect(heldCountText(0)).toBe("0 held for approval");
  expect(heldCountText(2)).toBe("2 held for approval");
});
