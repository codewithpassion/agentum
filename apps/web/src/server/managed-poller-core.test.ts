import { beforeEach, describe, expect, test } from "bun:test";
import type { ManagedStepResult } from "@repo/services/managed/types";
import {
  createPollerCore,
  type PollerStorage,
  RETRY_MS,
} from "./managed-poller-core.ts";

const START = Date.parse("2026-10-16T09:30:00.000Z");
const RUN = "run_1";

class FakeStorage implements PollerStorage {
  alarm: number | null = null;
  values = new Map<string, unknown>();

  delete(key: string) {
    return Promise.resolve(this.values.delete(key));
  }

  deleteAlarm() {
    this.alarm = null;
    return Promise.resolve();
  }

  get<T>(key: string) {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  getAlarm() {
    return Promise.resolve(this.alarm);
  }

  put<T>(key: string, value: T) {
    this.values.set(key, value);
    return Promise.resolve();
  }

  setAlarm(at: number) {
    this.alarm = at;
    return Promise.resolve();
  }
}

let nowMs: number;
let storage: FakeStorage;
let interrupted: string[];
let stepResult: () => Promise<ManagedStepResult>;
let steps: string[];

const newCore = (
  interrupt: (runId: string) => Promise<void> = (runId) => {
    interrupted.push(runId);
    return Promise.resolve();
  }
) =>
  createPollerCore({
    interrupt,
    now: () => nowMs,
    step: (runId) => {
      steps.push(runId);
      return stepResult();
    },
    storage,
  });

beforeEach(() => {
  nowMs = START;
  storage = new FakeStorage();
  interrupted = [];
  steps = [];
  stepResult = () => Promise.resolve({ next: null });
});

describe("kick", () => {
  test("stores the run id and sets an alarm now", async () => {
    const core = newCore();
    await core.kick(RUN);
    expect(storage.values.get("runId")).toBe(RUN);
    expect(storage.alarm).toBe(START);
  });

  test("a second kick while an alarm is pending does not move it", async () => {
    const core = newCore();
    await core.kick(RUN);
    nowMs = START + 5000;
    await core.kick(RUN);
    expect(storage.alarm).toBe(START);
  });
});

describe("alarm", () => {
  test("re-arms at now plus next when the run goes on", async () => {
    stepResult = () => Promise.resolve({ next: 2000 });
    const core = newCore();
    await core.kick(RUN);
    nowMs = START + 100;
    await core.alarm();
    expect(steps).toEqual([RUN]);
    expect(storage.alarm).toBe(START + 2100);
    expect(storage.values.get("runId")).toBe(RUN);
  });

  test("next null clears the id and sets no alarm", async () => {
    stepResult = () => Promise.resolve({ next: null });
    const core = newCore();
    await core.kick(RUN);
    await core.alarm();
    expect(storage.values.has("runId")).toBe(false);
    expect(storage.alarm).toBeNull();
  });

  test("a throwing step re-arms RETRY_MS later and the next alarm steps again", async () => {
    const errors: unknown[][] = [];
    const logged = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      stepResult = () => Promise.reject(new Error("anthropic 503"));
      const core = newCore();
      await core.kick(RUN);
      await core.alarm();
      expect(storage.alarm).toBe(START + RETRY_MS);
      expect(storage.values.get("runId")).toBe(RUN);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.[0]).toBe("ManagedPoller: step failed");

      nowMs = START + RETRY_MS;
      stepResult = () => Promise.resolve({ next: null });
      await core.alarm();
      expect(steps).toEqual([RUN, RUN]);
      expect(storage.values.has("runId")).toBe(false);
    } finally {
      console.error = logged;
    }
  });

  test("does nothing when no run id is stored", async () => {
    const core = newCore();
    await core.alarm();
    expect(steps).toEqual([]);
    expect(storage.alarm).toBeNull();
  });
});

describe("cancel", () => {
  test("interrupts, clears the alarm and the id", async () => {
    const core = newCore();
    await core.kick(RUN);
    await core.cancel(RUN);
    expect(interrupted).toEqual([RUN]);
    expect(storage.alarm).toBeNull();
    expect(storage.values.has("runId")).toBe(false);
  });

  test("still clears the alarm and the id when interrupt throws", async () => {
    const logged = console.error;
    console.error = () => undefined;
    try {
      const core = newCore(() => Promise.reject(new Error("network down")));
      await core.kick(RUN);
      await core.cancel(RUN);
      expect(storage.alarm).toBeNull();
      expect(storage.values.has("runId")).toBe(false);
    } finally {
      console.error = logged;
    }
  });
});
