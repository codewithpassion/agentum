// Run safeguards shared by the daemon and the web app: the turn limit an agent
// may set, the repeated-failure streak that stops a run, and the messages that
// tell the agent and the person what happened. Pure, so both sides agree.
import { z } from "zod";

/** The key in an agent's `runtimeConfig` that sets its turn limit. */
export const MAX_TURNS_KEY = "maxTurns";
export const MAX_TURNS_DEFAULT = 100;
export const MAX_TURNS_MIN = 10;
export const MAX_TURNS_MAX = 500;

/** The identical failed call that first gets a warning in the run. */
export const REPEAT_WARN_AT = 3;
/** The identical failed call that stops the run. */
export const REPEAT_STOP_AT = 5;

const TOOL_NAME_MAX = 200;

const isValidMaxTurns = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= MAX_TURNS_MIN &&
  value <= MAX_TURNS_MAX;

/** The turn limit for a run: the configured value when valid, otherwise the default. */
export const maxTurnsOf = (runtimeConfig: Record<string, unknown>): number => {
  const value = runtimeConfig[MAX_TURNS_KEY];
  return isValidMaxTurns(value) ? value : MAX_TURNS_DEFAULT;
};

/** Why the configured turn limit is invalid, or undefined when it is absent or valid. */
export const maxTurnsError = (
  runtimeConfig: Record<string, unknown>
): string | undefined => {
  const value = runtimeConfig[MAX_TURNS_KEY];
  if (value === undefined || isValidMaxTurns(value)) {
    return;
  }
  return `${MAX_TURNS_KEY} must be a whole number from ${MAX_TURNS_MIN} to ${MAX_TURNS_MAX}.`;
};

export const runStopSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    count: z.int().min(1),
    kind: z.literal("repeat"),
    tool: z.string().min(1).max(TOOL_NAME_MAX),
  }),
  z.strictObject({
    kind: z.literal("turn_limit"),
    limit: z.int().min(1),
  }),
]);
export type RunStop = z.infer<typeof runStopSchema>;

/** The line that closes a run stopped by a safeguard. */
export const stopMessage = (stop: RunStop): string =>
  stop.kind === "turn_limit"
    ? `Stopped after ${stop.limit} turns, the agent's limit`
    : `Stopped after ${stop.count} identical failed calls to ${stop.tool} in a row`;

/** The warning given to the agent before a repeated failing call stops the run. */
export const repeatWarning = (tool: string, count: number): string =>
  `Warning: you have called ${tool} ${count} times in a row with the same arguments and it failed every time. Repeating it will not work. Change course: use different arguments, use another tool, or tell the user what is blocking you. The run stops after ${REPEAT_STOP_AT} identical failed calls.`;

export interface ToolOutcome {
  input: unknown;
  name: string;
  ok: boolean;
}

export interface Streak {
  count: number;
  key: string;
  tool: string;
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [
          key,
          canonicalize((value as Record<string, unknown>)[key]),
        ])
    );
  }
  return value;
};

/** A key that matches for the same tool and the same arguments, whatever their key order. */
export const callKey = (name: string, input: unknown): string =>
  `${name}\n${JSON.stringify(canonicalize(input ?? null))}`;

/** The streak after one more outcome. A success ends it; a new failing call starts one at 1. */
export const nextStreak = (
  previous: Streak | undefined,
  outcome: ToolOutcome
): Streak | undefined => {
  if (outcome.ok) {
    return;
  }
  const key = callKey(outcome.name, outcome.input);
  if (previous?.key === key) {
    return { ...previous, count: previous.count + 1 };
  }
  return { count: 1, key, tool: outcome.name };
};

/** The streak left at the end of a sequence of tool outcomes. */
export const streakOf = (
  outcomes: readonly ToolOutcome[]
): Streak | undefined =>
  outcomes.reduce<Streak | undefined>(nextStreak, undefined);
