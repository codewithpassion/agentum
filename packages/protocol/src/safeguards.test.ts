// Tests for the run safeguards: the turn limit, the repeated-failure streak,
// the stop and warning texts, and the stop schema.
import { describe, expect, test } from "bun:test";
import {
  callKey,
  MAX_TURNS_DEFAULT,
  MAX_TURNS_KEY,
  MAX_TURNS_MAX,
  MAX_TURNS_MIN,
  maxTurnsError,
  maxTurnsOf,
  REPEAT_STOP_AT,
  repeatWarning,
  runStopSchema,
  stopMessage,
  streakOf,
  type ToolOutcome,
} from "./safeguards.ts";

const fail = (name: string, input: unknown = { path: "a" }): ToolOutcome => ({
  input,
  name,
  ok: false,
});
const succeed = (
  name: string,
  input: unknown = { path: "a" }
): ToolOutcome => ({
  input,
  name,
  ok: true,
});

describe("maxTurnsOf", () => {
  test("defaults when the key is absent", () => {
    expect(maxTurnsOf({})).toBe(MAX_TURNS_DEFAULT);
  });

  test("returns a configured value in range", () => {
    expect(maxTurnsOf({ [MAX_TURNS_KEY]: 250 })).toBe(250);
  });

  test("accepts the bounds", () => {
    expect(maxTurnsOf({ [MAX_TURNS_KEY]: MAX_TURNS_MIN })).toBe(MAX_TURNS_MIN);
    expect(maxTurnsOf({ [MAX_TURNS_KEY]: MAX_TURNS_MAX })).toBe(MAX_TURNS_MAX);
  });

  test("falls back to the default below the minimum", () => {
    expect(maxTurnsOf({ [MAX_TURNS_KEY]: MAX_TURNS_MIN - 1 })).toBe(
      MAX_TURNS_DEFAULT
    );
  });

  test("falls back to the default above the maximum", () => {
    expect(maxTurnsOf({ [MAX_TURNS_KEY]: MAX_TURNS_MAX + 1 })).toBe(
      MAX_TURNS_DEFAULT
    );
  });

  test("falls back to the default for a non-integer", () => {
    expect(maxTurnsOf({ [MAX_TURNS_KEY]: 50.5 })).toBe(MAX_TURNS_DEFAULT);
  });

  test("falls back to the default for a non-number", () => {
    expect(maxTurnsOf({ [MAX_TURNS_KEY]: "50" })).toBe(MAX_TURNS_DEFAULT);
    expect(maxTurnsOf({ [MAX_TURNS_KEY]: null })).toBe(MAX_TURNS_DEFAULT);
  });
});

describe("maxTurnsError", () => {
  test("is undefined when the key is absent", () => {
    expect(maxTurnsError({})).toBeUndefined();
  });

  test("is undefined when the value is valid", () => {
    expect(maxTurnsError({ [MAX_TURNS_KEY]: 100 })).toBeUndefined();
  });

  test("names the range when the value is invalid", () => {
    expect(maxTurnsError({ [MAX_TURNS_KEY]: 9 })).toBe(
      "maxTurns must be a whole number from 10 to 500."
    );
    expect(maxTurnsError({ [MAX_TURNS_KEY]: 1.5 })).toBe(
      "maxTurns must be a whole number from 10 to 500."
    );
  });
});

describe("stopMessage", () => {
  test("describes a turn limit stop", () => {
    expect(stopMessage({ kind: "turn_limit", limit: 100 })).toBe(
      "Stopped after 100 turns, the agent's limit"
    );
  });

  test("describes a repeat stop", () => {
    expect(stopMessage({ count: 5, kind: "repeat", tool: "bash" })).toBe(
      "Stopped after 5 identical failed calls to bash in a row"
    );
  });
});

describe("callKey", () => {
  test("ignores object key order", () => {
    expect(callKey("t", { a: 1, b: 2 })).toBe(callKey("t", { a: 1, b: 2 }));
  });

  test("ignores key order in nested objects", () => {
    expect(callKey("t", { x: { a: 1, b: 2 } })).toBe(
      callKey("t", { x: { a: 1, b: 2 } })
    );
  });

  test("keeps array order", () => {
    expect(callKey("t", [1, 2])).not.toBe(callKey("t", [2, 1]));
  });

  test("treats undefined input like null", () => {
    expect(callKey("t", undefined)).toBe(callKey("t", null));
  });

  test("differs by tool name", () => {
    expect(callKey("a", {})).not.toBe(callKey("b", {}));
  });
});

describe("streakOf", () => {
  test("counts four identical failures", () => {
    const streak = streakOf([
      fail("bash"),
      fail("bash"),
      fail("bash"),
      fail("bash"),
    ]);
    expect(streak?.count).toBe(4);
    expect(streak?.tool).toBe("bash");
  });

  test("counts five identical failures", () => {
    const streak = streakOf(
      Array.from({ length: REPEAT_STOP_AT }, () => fail("bash"))
    );
    expect(streak?.count).toBe(REPEAT_STOP_AT);
  });

  test("resets to one when the arguments change in the middle", () => {
    const streak = streakOf([
      fail("bash", { cmd: "a" }),
      fail("bash", { cmd: "a" }),
      fail("bash", { cmd: "b" }),
    ]);
    expect(streak?.count).toBe(1);
    expect(streak?.tool).toBe("bash");
  });

  test("ends on a success and restarts after it", () => {
    expect(
      streakOf([fail("bash"), fail("bash"), succeed("bash")])
    ).toBeUndefined();
    const streak = streakOf([
      fail("bash"),
      fail("bash"),
      succeed("bash"),
      fail("bash"),
    ]);
    expect(streak?.count).toBe(1);
  });

  test("resets to one when a different tool fails", () => {
    const streak = streakOf([fail("bash"), fail("bash"), fail("read")]);
    expect(streak?.count).toBe(1);
    expect(streak?.tool).toBe("read");
  });

  test("is undefined for no outcomes", () => {
    expect(streakOf([])).toBeUndefined();
  });
});

describe("repeatWarning", () => {
  test("names the tool, the count and the stop point", () => {
    expect(repeatWarning("bash", 3)).toBe(
      "Warning: you have called bash 3 times in a row with the same arguments and it failed every time. Repeating it will not work. Change course: use different arguments, use another tool, or tell the user what is blocking you. The run stops after 5 identical failed calls."
    );
  });
});

describe("runStopSchema", () => {
  test("accepts a repeat stop", () => {
    expect(
      runStopSchema.safeParse({ count: 5, kind: "repeat", tool: "bash" })
        .success
    ).toBe(true);
  });

  test("accepts a turn limit stop", () => {
    expect(
      runStopSchema.safeParse({ kind: "turn_limit", limit: 100 }).success
    ).toBe(true);
  });

  test("rejects an unknown kind", () => {
    expect(
      runStopSchema.safeParse({ kind: "timeout", limit: 100 }).success
    ).toBe(false);
  });

  test("rejects extra keys", () => {
    expect(
      runStopSchema.safeParse({ extra: true, kind: "turn_limit", limit: 100 })
        .success
    ).toBe(false);
  });
});
