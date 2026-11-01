import { expect, test } from "bun:test";
import { acceptProtoNames } from "./proto-names.ts";

test("renames proto field names to camelCase, deeply", () => {
  expect(
    acceptProtoNames({
      message: {
        message_id: "m1",
        parts: [{ media_type: "text/plain", text: "hi" }],
        reference_task_ids: ["t1"],
      },
      task_id: "t",
    })
  ).toEqual({
    message: {
      messageId: "m1",
      parts: [{ mediaType: "text/plain", text: "hi" }],
      referenceTaskIds: ["t1"],
    },
    taskId: "t",
  });
});

test("leaves metadata and data contents alone", () => {
  expect(
    acceptProtoNames({
      message: {
        metadata: { some_key: { inner_key: 1 } },
        parts: [{ data: { a_b: 2 } }],
      },
    })
  ).toEqual({
    message: {
      metadata: { some_key: { inner_key: 1 } },
      parts: [{ data: { a_b: 2 } }],
    },
  });
});

test("keeps camelCase as it is, and prefers it when both spellings arrive", () => {
  expect(acceptProtoNames({ task_id: "b", taskId: "a" })).toEqual({
    taskId: "a",
  });
  expect(acceptProtoNames({ pageSize: 5 })).toEqual({ pageSize: 5 });
});

test("passes scalars and null through", () => {
  expect(acceptProtoNames(null)).toBeNull();
  expect(acceptProtoNames("x_y")).toBe("x_y");
});
