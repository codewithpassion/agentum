import { describe, expect, spyOn, test } from "bun:test";
import type { CloudStart } from "@repo/services/cloud/types";
import type { RunStorage } from "./pi-run-core.ts";
import { createStartQueue, START_TIMEOUT_MS } from "./pi-run-start.ts";

const memoryStorage = (): RunStorage => {
  const data = new Map<string, unknown>();
  return {
    delete: (key) => Promise.resolve(data.delete(key)),
    // Like Durable Object storage, reads give a copy.
    get: <T>(key: string) =>
      Promise.resolve(structuredClone(data.get(key)) as T | undefined),
    put: <T>(key: string, value: T) => {
      data.set(key, structuredClone(value));
      return Promise.resolve();
    },
  };
};

const startOf = (runId: string, runToken = "token"): CloudStart => ({
  agent: {
    id: "a1",
    instructions: "Be brief.",
    model: "sonnet",
    name: "Pelican",
    runtimeConfig: {},
    slug: "pelican",
  },
  inputFileIds: [],
  mcpServers: {},
  run: {
    agentId: "a1",
    id: runId,
    inputText: "Hello",
    sessionId: "s1",
    workspaceId: "w1",
  },
  runToken,
});

const setup = (
  overrides: {
    begin?: (input: CloudStart) => Promise<void>;
    claim?: (runId: string) => Promise<"claimed" | "conflict" | "running">;
    prepare?: (input: CloudStart) => Promise<void>;
  } = {}
) => {
  const storage = memoryStorage();
  const calls: string[] = [];
  const failures: [string, string][] = [];
  const clock = { ms: 1_000_000 };
  const build = () =>
    createStartQueue({
      begin: async (input) => {
        calls.push(`begin ${input.run.id} ${input.runToken}`);
        await overrides.begin?.(input);
      },
      claim: (runId) => {
        calls.push(`claim ${runId}`);
        return overrides.claim?.(runId) ?? Promise.resolve("claimed");
      },
      fail: (runId, error) => {
        failures.push([runId, error]);
        return Promise.resolve();
      },
      now: () => clock.ms,
      prepare: async (input) => {
        calls.push(`prepare ${input.run.id}`);
        await overrides.prepare?.(input);
      },
      storage,
    });
  return { build, calls, clock, failures, queue: build() };
};

describe("request", () => {
  test("only saves the start: nothing is claimed or begun until the alarm works it", async () => {
    const { calls, queue } = setup();
    await queue.request(startOf("r1"));
    expect(calls).toEqual([]);
    expect(await queue.hasPending()).toBe(true);
  });

  test("a start that was cut off after it was accepted is finished by a fresh queue over the same storage", async () => {
    const { build, calls, queue } = setup();
    await queue.request(startOf("r1"));
    // The object was evicted: a new queue is built over the same storage.
    const resumed = build();
    expect(await resumed.hasPending()).toBe(true);
    expect(await resumed.work()).toBe(false);
    expect(calls).toEqual(["claim r1", "prepare r1", "begin r1 token"]);
    expect(await resumed.hasPending()).toBe(false);
  });

  test("a repeat for the same run keeps one start and takes the newer token", async () => {
    const { calls, queue } = setup();
    await queue.request(startOf("r1", "old"));
    await queue.request(startOf("r1", "new"));
    await queue.work();
    expect(calls).toEqual(["claim r1", "prepare r1", "begin r1 new"]);
  });
});

describe("work", () => {
  test("starts every saved run in the order they were saved", async () => {
    const { calls, queue } = setup();
    await queue.request(startOf("r1"));
    await queue.request(startOf("r2"));
    await queue.work();
    expect(calls).toEqual([
      "claim r1",
      "prepare r1",
      "begin r1 token",
      "claim r2",
      "prepare r2",
      "begin r2 token",
    ]);
  });

  test("a run that cannot be claimed is dropped, left for the platform to offer again", async () => {
    const { calls, queue } = setup({
      claim: () => Promise.resolve("conflict"),
    });
    await queue.request(startOf("r1"));
    expect(await queue.work()).toBe(false);
    expect(calls).toEqual(["claim r1"]);
    expect(await queue.hasPending()).toBe(false);
  });

  test("a failed setup is tried again without claiming twice", async () => {
    let attempts = 0;
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    const { calls, queue } = setup({
      prepare: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("VM not ready"))
          : Promise.resolve();
      },
    });
    await queue.request(startOf("r1"));
    expect(await queue.work()).toBe(true);
    expect(await queue.work()).toBe(false);
    errors.mockRestore();
    expect(calls).toEqual([
      "claim r1",
      "prepare r1",
      "prepare r1",
      "begin r1 token",
    ]);
  });

  test("a claimed run that cannot start in time is failed with a stated reason", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    const { clock, failures, queue } = setup({
      prepare: () => Promise.reject(new Error("VM not ready")),
    });
    await queue.request(startOf("r1"));
    expect(await queue.work()).toBe(true);
    clock.ms += START_TIMEOUT_MS;
    expect(await queue.work()).toBe(false);
    errors.mockRestore();
    expect(failures).toEqual([
      ["r1", "The run could not start within 2 minutes: VM not ready"],
    ]);
    expect(await queue.hasPending()).toBe(false);
  });

  test("a claim that went through before the object saved it is recognised on the retry", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    let attempts = 0;
    const { calls, queue } = setup({
      claim: () => {
        attempts += 1;
        // The first call wrote the row, then the object failed before it saw the answer.
        return attempts === 1
          ? Promise.reject(new Error("evicted"))
          : Promise.resolve("running");
      },
    });
    await queue.request(startOf("r1"));
    expect(await queue.work()).toBe(true);
    expect(await queue.work()).toBe(false);
    errors.mockRestore();
    expect(calls).toEqual([
      "claim r1",
      "claim r1",
      "prepare r1",
      "begin r1 token",
    ]);
  });

  test("a run that is already running without a claim of ours is not started again", async () => {
    const { calls, queue } = setup({ claim: () => Promise.resolve("running") });
    await queue.request(startOf("r1"));
    expect(await queue.work()).toBe(false);
    expect(calls).toEqual(["claim r1"]);
    expect(await queue.hasPending()).toBe(false);
  });

  test("a setup that never finishes is cut off at the deadline and the claimed run is failed", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    const { clock, failures, queue } = setup({
      prepare: () => new Promise<void>(() => undefined),
    });
    await queue.request(startOf("r1"));
    // Ten milliseconds are left of the two minutes, so the step is cut off after the one-second floor.
    clock.ms += START_TIMEOUT_MS - 10;
    expect(await queue.work()).toBe(false);
    errors.mockRestore();
    expect(failures).toEqual([
      [
        "r1",
        "The run could not start within 2 minutes: setup did not finish in time",
      ],
    ]);
    expect(await queue.hasPending()).toBe(false);
  });

  test("a run nobody claimed is dropped at the timeout without failing it, so the sweep offers it again", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    const { clock, failures, queue } = setup({
      claim: () => Promise.reject(new Error("D1 down")),
    });
    await queue.request(startOf("r1"));
    clock.ms += START_TIMEOUT_MS;
    expect(await queue.work()).toBe(false);
    errors.mockRestore();
    expect(failures).toEqual([]);
    expect(await queue.hasPending()).toBe(false);
  });

  test("a start saved while the queue is working is worked in the same pass", async () => {
    let saveSecond: () => Promise<void> = () => Promise.resolve();
    const { calls, queue } = setup({
      begin: async (input) => {
        if (input.run.id === "r1") {
          await saveSecond();
        }
      },
    });
    saveSecond = () => queue.request(startOf("r2"));
    await queue.request(startOf("r1"));
    await queue.work();
    expect(calls).toContain("begin r2 token");
    expect(await queue.hasPending()).toBe(false);
  });
});
