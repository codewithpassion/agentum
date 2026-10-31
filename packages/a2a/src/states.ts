import { z } from "zod";

/**
 * `TaskState` from the proto, without `TASK_STATE_UNSPECIFIED`, which is the
 * proto3 zero value and never a real state.
 */
export const TASK_STATES = [
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const taskStateSchema = z.enum(TASK_STATES);

/** The task is over and will not change again. */
export const TERMINAL_TASK_STATES = [
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
] as const satisfies readonly TaskState[];

/** The task waits for the client or a person before it can go on. */
export const INTERRUPTED_TASK_STATES = [
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_AUTH_REQUIRED",
] as const satisfies readonly TaskState[];

export const isTerminalTaskState = (state: TaskState): boolean =>
  (TERMINAL_TASK_STATES as readonly TaskState[]).includes(state);

export const isInterruptedTaskState = (state: TaskState): boolean =>
  (INTERRUPTED_TASK_STATES as readonly TaskState[]).includes(state);

/**
 * A blocking `SendMessage` returns and a stream closes at a terminal or an
 * interrupted state.
 */
export const isSettledTaskState = (state: TaskState): boolean =>
  isTerminalTaskState(state) || isInterruptedTaskState(state);
