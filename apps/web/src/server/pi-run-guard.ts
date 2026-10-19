// Warns the agent when it repeats the same failing tool call. The streak logic is
// pure and lives in @repo/protocol/safeguards; this file keeps the streak in the
// run's storage and adds the warning to the tool result.
import type {
  ToolDiagnostic,
  ToolExecutionResult,
  ToolHookCall,
} from "@earendil-works/pi-durable";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import {
  nextStreak,
  REPEAT_WARN_AT,
  repeatWarning,
  type Streak,
} from "@repo/protocol/safeguards";

/** The storage key of the streak of identical failing calls. */
export const STREAK_KEY = "repeat-streak";

/** The part of a Durable Object's storage this guard uses. */
export interface StreakStorage {
  delete: (key: string) => Promise<unknown>;
  get: <T>(key: string) => Promise<T | undefined>;
  put: <T>(key: string, value: T) => Promise<void>;
}

/** Forgets the streak, so a new run starts without one. */
export const resetStreak = (storage: StreakStorage): Promise<unknown> =>
  storage.delete(STREAK_KEY);

/** Adds the warning to the output, or to the diagnostics when the result has no output. */
const withWarning = (
  result: ToolExecutionResult,
  warning: string
): ToolExecutionResult => {
  if (result.output === undefined) {
    const diagnostic: ToolDiagnostic = {
      code: "repeat-warning",
      message: warning,
      severity: "warn",
    };
    return {
      ...result,
      diagnostics: [...(result.diagnostics ?? []), diagnostic],
    };
  }
  return {
    ...result,
    output: [...result.output, { text: warning, type: "text" }],
  };
};

/** The `afterTool` handler: counts the streak and warns on the third identical failure. */
export const repeatGuardHook =
  (storage: StreakStorage) =>
  async (
    call: ToolHookCall,
    result: ToolExecutionResult
  ): Promise<ToolExecutionResult | undefined> => {
    try {
      const previous = await storage.get<Streak>(STREAK_KEY);
      const streak = nextStreak(previous, {
        input: call.arguments,
        name: call.name,
        ok: result.isError !== true,
      });
      if (streak === undefined) {
        await storage.delete(STREAK_KEY);
        return;
      }
      await storage.put(STREAK_KEY, streak);
      if (streak.count !== REPEAT_WARN_AT) {
        return;
      }
      return withWarning(result, repeatWarning(streak.tool, streak.count));
    } catch (error) {
      // A throw here would block the tool, so a storage error only costs the warning.
      console.warn("RepeatGuard: streak not updated", error);
    }
  };

/** The extension that installs the repeat guard on every tool call. */
export const repeatGuardExtension = (storage: StreakStorage) =>
  defineExtension({
    hooks: [hook(ToolTask, { afterTool: repeatGuardHook(storage) })],
    name: "repeat-guard",
  });
