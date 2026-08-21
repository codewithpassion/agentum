import { describe, expect, test } from "bun:test";
import { THINKING_KEY, THINKING_KEY_PREFIX } from "./state";

/**
 * The indicator keys, which are the whole reason a "Thinking…" can be taken
 * back. One key per agent looked right and was not: a session woken for a
 * second thread before it answered the first would overwrite the first key,
 * and the message it pointed at would sit in Slack with nothing left that
 * knew how to remove it.
 */

const AGENT = "agent_bruce";
const OTHER_AGENT = "agent_ada";

describe("THINKING_KEY", () => {
  test("two threads for one agent are two keys", () => {
    expect(THINKING_KEY(AGENT, "message_a")).not.toBe(
      THINKING_KEY(AGENT, "message_b")
    );
  });

  test("the agent's prefix matches every thread it is thinking in", () => {
    const prefix = THINKING_KEY_PREFIX(AGENT);
    for (const threadParentId of ["message_a", "message_b"]) {
      expect(THINKING_KEY(AGENT, threadParentId).startsWith(prefix)).toBe(true);
    }
  });

  test("one agent's prefix does not reach another's indicators", () => {
    // Retiring Bruce's indicators must not take down Ada's.
    expect(
      THINKING_KEY(OTHER_AGENT, "message_a").startsWith(
        THINKING_KEY_PREFIX(AGENT)
      )
    ).toBe(false);
  });
});
