import { expect, test } from "bun:test";
import { replyTargetSchema } from "./types.ts";

test("an a2a reply target holds a task id and nothing else", () => {
  expect(replyTargetSchema.parse({ kind: "a2a", taskId: "t1" })).toEqual({
    kind: "a2a",
    taskId: "t1",
  });
  expect(replyTargetSchema.safeParse({ kind: "a2a" }).success).toBe(false);
  expect(
    replyTargetSchema.safeParse({ extra: 1, kind: "a2a", taskId: "t1" }).success
  ).toBe(false);
});
