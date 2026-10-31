import { describe, expect, test } from "bun:test";
import {
  INTERRUPTED_TASK_STATES,
  isInterruptedTaskState,
  isSettledTaskState,
  isTerminalTaskState,
  TASK_STATES,
  TERMINAL_TASK_STATES,
  taskStateSchema,
} from "./states.ts";

const TERMINAL = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);
const INTERRUPTED = new Set([
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_AUTH_REQUIRED",
]);

describe("task state helpers", () => {
  test("the two lists name the states the spec does", () => {
    expect(new Set<string>(TERMINAL_TASK_STATES)).toEqual(TERMINAL);
    expect(new Set<string>(INTERRUPTED_TASK_STATES)).toEqual(INTERRUPTED);
  });

  for (const state of TASK_STATES) {
    test(`${state}`, () => {
      expect(isTerminalTaskState(state)).toBe(TERMINAL.has(state));
      expect(isInterruptedTaskState(state)).toBe(INTERRUPTED.has(state));
      expect(isSettledTaskState(state)).toBe(
        TERMINAL.has(state) || INTERRUPTED.has(state)
      );
    });
  }

  test("a state is never both terminal and interrupted", () => {
    for (const state of TASK_STATES) {
      expect(isTerminalTaskState(state) && isInterruptedTaskState(state)).toBe(
        false
      );
    }
  });

  test("submitted and working are neither terminal nor interrupted", () => {
    for (const state of [
      "TASK_STATE_SUBMITTED",
      "TASK_STATE_WORKING",
    ] as const) {
      expect(isSettledTaskState(state)).toBe(false);
    }
  });

  test("the schema takes the wire names only", () => {
    expect(taskStateSchema.safeParse("TASK_STATE_WORKING").success).toBe(true);
    expect(taskStateSchema.safeParse("working").success).toBe(false);
    expect(taskStateSchema.safeParse("TASK_STATE_UNSPECIFIED").success).toBe(
      false
    );
  });
});
