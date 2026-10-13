import { describe, expect, test } from "bun:test";
import { sessionResetMessage } from "./agent-session";

describe("sessionResetMessage", () => {
  test("says the next message starts a session when one was retired", () => {
    expect(sessionResetMessage(true)).toBe(
      "New session starts with the next message."
    );
  });

  test("says nothing was running when no session was retired", () => {
    expect(sessionResetMessage(false)).toBe("No session was running.");
  });
});
