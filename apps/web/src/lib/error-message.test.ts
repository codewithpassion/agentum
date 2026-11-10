import { expect, test } from "bun:test";
import { TRPCClientError } from "@trpc/client";
import { errorMessage, errorReason } from "./error-message.ts";

test("an Error gives its message", () => {
  expect(errorMessage(new Error("Nope."))).toBe("Nope.");
});

test("anything else gives the fallback", () => {
  expect(errorMessage("text")).toBe("Something went wrong.");
  expect(errorMessage(undefined, "Could not save")).toBe("Could not save");
});

test("errorReason reads the reason a tRPC error carries", () => {
  const withReason = Object.assign(new TRPCClientError("No."), {
    data: { code: "BAD_REQUEST", reason: "key_in_message" },
  });
  expect(errorReason(withReason)).toBe("key_in_message");
  const without = Object.assign(new TRPCClientError("No."), {
    data: { code: "BAD_REQUEST", reason: null },
  });
  expect(errorReason(without)).toBeNull();
  expect(errorReason(new Error("No."))).toBeNull();
});
