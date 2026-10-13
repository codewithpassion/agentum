import { describe, expect, test } from "bun:test";
import { sessionResetMessage } from "./agent-session";

describe("sessionResetMessage", () => {
  test("says the next message starts a session when one was retired", () => {
    expect(sessionResetMessage(true)).toBe(
      "Session reset. The agent starts a new one with its next message."
    );
  });

  test("says nothing was running when no session was retired", () => {
    expect(sessionResetMessage(false)).toBe(
      "The agent had no running session. Its next message starts a new one."
    );
  });
});
