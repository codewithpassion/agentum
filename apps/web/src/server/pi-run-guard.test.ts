import { describe, expect, test } from "bun:test";
import type {
  ToolExecutionResult,
  ToolHookCall,
} from "@earendil-works/pi-durable";
import { REPEAT_WARN_AT, repeatWarning } from "@repo/protocol/safeguards";
import {
  repeatGuardHook,
  resetStreak,
  STREAK_KEY,
  type StreakStorage,
} from "./pi-run-guard.ts";

const TOOL = "bash";
const ARGS = { command: "ls /missing" };

const memoryStorage = () => {
  const data = new Map<string, unknown>();
  const storage: StreakStorage = {
    delete: (key) => Promise.resolve(data.delete(key)),
    get: <T>(key: string) => Promise.resolve(data.get(key) as T | undefined),
    put: <T>(key: string, value: T) => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
  return { data, storage };
};

const brokenStorage: StreakStorage = {
  delete: () => Promise.reject(new Error("storage down")),
  get: () => Promise.reject(new Error("storage down")),
  put: () => Promise.reject(new Error("storage down")),
};

const callWith = (
  args: ToolHookCall["arguments"],
  name = TOOL
): ToolHookCall => ({
  arguments: args,
  id: "call-1",
  name,
  type: "toolCall",
});

const failure = (): ToolExecutionResult => ({
  isError: true,
  output: [{ text: "exit 2", type: "text" }],
});

const success = (): ToolExecutionResult => ({
  isError: false,
  output: [{ text: "ok", type: "text" }],
});

const warning = repeatWarning(TOOL, REPEAT_WARN_AT);

describe("repeatGuardHook", () => {
  test("stays silent on the first and second identical failure", async () => {
    const { storage } = memoryStorage();
    const hook = repeatGuardHook(storage);

    expect(await hook(callWith(ARGS), failure())).toBeUndefined();
    expect(await hook(callWith(ARGS), failure())).toBeUndefined();
  });

  test("appends the warning to the output on the third identical failure", async () => {
    const { storage } = memoryStorage();
    const hook = repeatGuardHook(storage);
    const result: ToolExecutionResult = {
      isError: true,
      output: [
        { text: "exit 2", type: "text" },
        { text: "no such file", type: "text" },
      ],
    };

    await hook(callWith(ARGS), failure());
    await hook(callWith(ARGS), failure());
    const guarded = await hook(callWith(ARGS), result);

    expect(guarded?.isError).toBe(true);
    expect(guarded?.output).toEqual([
      { text: "exit 2", type: "text" },
      { text: "no such file", type: "text" },
      { text: warning, type: "text" },
    ]);
    expect(result.output).toHaveLength(2);
  });

  test("stays silent after the warning, on the fourth identical failure", async () => {
    const { storage } = memoryStorage();
    const hook = repeatGuardHook(storage);

    await hook(callWith(ARGS), failure());
    await hook(callWith(ARGS), failure());
    await hook(callWith(ARGS), failure());

    expect(await hook(callWith(ARGS), failure())).toBeUndefined();
  });

  test("a different argument starts the count again", async () => {
    const { storage } = memoryStorage();
    const hook = repeatGuardHook(storage);

    await hook(callWith(ARGS), failure());
    await hook(callWith(ARGS), failure());

    expect(
      await hook(callWith({ command: "ls /other" }), failure())
    ).toBeUndefined();
    expect(await hook(callWith(ARGS), failure())).toBeUndefined();
  });

  test("a successful call in between resets the count", async () => {
    const { storage } = memoryStorage();
    const hook = repeatGuardHook(storage);

    await hook(callWith(ARGS), failure());
    await hook(callWith(ARGS), failure());
    expect(await hook(callWith(ARGS), success())).toBeUndefined();

    expect(await hook(callWith(ARGS), failure())).toBeUndefined();
    expect(await hook(callWith(ARGS), failure())).toBeUndefined();
    expect(await hook(callWith(ARGS), failure())).toBeDefined();
  });

  test("puts the warning in diagnostics when the result has no output", async () => {
    const { storage } = memoryStorage();
    const hook = repeatGuardHook(storage);
    const earlier = {
      code: "earlier",
      message: "something first",
      severity: "info" as const,
    };
    const bare: ToolExecutionResult = {
      diagnostics: [earlier],
      isError: true,
    };

    await hook(callWith(ARGS), failure());
    await hook(callWith(ARGS), failure());
    const guarded = await hook(callWith(ARGS), bare);

    expect(guarded?.output).toBeUndefined();
    expect(guarded?.diagnostics).toEqual([
      earlier,
      { code: "repeat-warning", message: warning, severity: "warn" },
    ]);
  });

  test("returns undefined when the storage throws", async () => {
    const hook = repeatGuardHook(brokenStorage);

    expect(await hook(callWith(ARGS), failure())).toBeUndefined();
  });
});

describe("resetStreak", () => {
  test("clears the streak so the next failure counts from one", async () => {
    const { data, storage } = memoryStorage();
    const hook = repeatGuardHook(storage);

    await hook(callWith(ARGS), failure());
    await hook(callWith(ARGS), failure());
    await resetStreak(storage);

    expect(data.has(STREAK_KEY)).toBe(false);
    expect(await hook(callWith(ARGS), failure())).toBeUndefined();
    expect(await hook(callWith(ARGS), failure())).toBeUndefined();
    expect(await hook(callWith(ARGS), failure())).toBeDefined();
  });
});
