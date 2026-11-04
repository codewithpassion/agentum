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

test("app reply targets default state and bound it to 4096 characters", () => {
  expect(replyTargetSchema.parse({ artifactId: "a1", kind: "app" })).toEqual({
    artifactId: "a1",
    kind: "app",
    state: "",
  });
  expect(
    replyTargetSchema.safeParse({
      artifactId: "a1",
      kind: "app",
      state: "x".repeat(4096),
    }).success
  ).toBe(true);
  expect(
    replyTargetSchema.safeParse({
      artifactId: "a1",
      kind: "app",
      state: "x".repeat(4097),
    }).success
  ).toBe(false);
  expect(
    replyTargetSchema.safeParse({ artifactId: "", kind: "app" }).success
  ).toBe(false);
});
