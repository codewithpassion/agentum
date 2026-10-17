import { describe, expect, test } from "bun:test";
import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { SLOW_READ_TOOL, slowReadTool } from "./pi-run-dev-tools.ts";

// The slow read tool never reads the API, so the tests pass an empty one.
const NO_API = {} as ToolExecutionApi;
const contextWith = (abortSignal?: AbortSignal): Context => ({
  abortSignal,
  toString: () => "test-context",
  value: () => undefined,
});

describe("slowReadTool", () => {
  test("is named dev_slow_read and is safe to replay", () => {
    const tool = slowReadTool({ countStart: () => Promise.resolve(1) });

    expect(tool.name).toBe(SLOW_READ_TOOL);
    expect(tool.name).toBe("dev_slow_read");
    expect(tool.replay).toBe("safe");
  });

  test("execute returns the start count and counts once per call", async () => {
    let starts = 0;
    const tool = slowReadTool({
      countStart: () => {
        starts += 1;
        return Promise.resolve(starts);
      },
      sleepMs: 5,
    });

    const first = await tool.execute({}, NO_API, contextWith());
    const second = await tool.execute({}, NO_API, contextWith());

    expect(first).toEqual({
      isError: false,
      output: [{ text: "slow read done, started 1 times", type: "text" }],
    });
    expect(second.isError).toBe(false);
    expect(second.output).toEqual([
      { text: "slow read done, started 2 times", type: "text" },
    ]);
    expect(starts).toBe(2);
  });

  test("an already aborted signal ends the sleep at once", async () => {
    const controller = new AbortController();
    controller.abort();
    // Far longer than the test timeout, so a sleep that ignores the signal fails.
    const tool = slowReadTool({
      countStart: () => Promise.resolve(1),
      sleepMs: 60_000,
    });

    const result = await tool.execute(
      {},
      NO_API,
      contextWith(controller.signal)
    );

    expect(result.isError).toBe(false);
  });
});
