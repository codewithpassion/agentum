import { describe, expect, test } from "bun:test";
import type { StreamFrame } from "@repo/protocol/stream";
import {
  createStreamCore,
  type Every,
  type FrameWriter,
  PING_INTERVAL_MS,
} from "./session-stream-core.ts";

const eventFrame: StreamFrame = {
  actor: { id: "user_1", kind: "user" },
  createdAt: "2026-10-16T09:30:00.000Z",
  frame: "event",
  id: "01EVENT",
  payload: {},
  runId: "run_1",
  seq: 1,
  type: "message.user",
};

class FakeWriter implements FrameWriter {
  chunks: string[] = [];
  closed = false;
  failing: boolean;

  constructor() {
    this.failing = false;
  }

  close() {
    this.closed = true;
  }

  write(chunk: string) {
    if (this.failing) {
      return Promise.reject(new Error("client gone"));
    }
    this.chunks.push(chunk);
    return Promise.resolve();
  }
}

const fakeEvery = () => {
  const calls: { ms: number; tick: () => void }[] = [];
  let cancelled = 0;
  const every: Every = (ms, tick) => {
    calls.push({ ms, tick });
    return () => {
      cancelled += 1;
    };
  };
  return { calls, cancelled: () => cancelled, every };
};

describe("createStreamCore fan-out", () => {
  test("an event frame reaches every writer with the same SSE text", async () => {
    const { every } = fakeEvery();
    const core = createStreamCore({ every });
    const first = new FakeWriter();
    const second = new FakeWriter();
    core.add(first);
    core.add(second);

    await core.publish(eventFrame);

    const expected = `id: 01EVENT\ndata: ${JSON.stringify(eventFrame)}\n\n`;
    expect(first.chunks).toEqual([expected]);
    expect(second.chunks).toEqual([expected]);
  });

  test("a non-event frame has no id line", async () => {
    const { every } = fakeEvery();
    const core = createStreamCore({ every });
    const writer = new FakeWriter();
    core.add(writer);

    await core.publish({ frame: "run", runId: "run_1", status: "running" });

    expect(writer.chunks).toHaveLength(1);
    expect(writer.chunks[0]).not.toContain("id:");
    expect(writer.chunks[0]).toBe(
      'data: {"frame":"run","runId":"run_1","status":"running"}\n\n'
    );
  });

  test("a writer whose write rejects is dropped and the others still get the frame", async () => {
    const { every, cancelled } = fakeEvery();
    const core = createStreamCore({ every });
    const broken = new FakeWriter();
    const healthy = new FakeWriter();
    core.add(broken);
    core.add(healthy);
    broken.failing = true;

    await core.publish(eventFrame);

    expect(core.size()).toBe(1);
    expect(broken.closed).toBe(true);
    expect(healthy.chunks).toHaveLength(1);
    expect(cancelled()).toBe(0);

    await core.publish({ frame: "ping" });
    expect(broken.chunks).toHaveLength(0);
    expect(healthy.chunks).toHaveLength(2);
  });
});

describe("createStreamCore ping", () => {
  test("starts one timer at PING_INTERVAL_MS and pings writers on each tick", async () => {
    const { calls, every } = fakeEvery();
    const core = createStreamCore({ every });
    const writer = new FakeWriter();
    core.add(writer);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.ms).toBe(25_000);
    expect(PING_INTERVAL_MS).toBe(25_000);

    calls[0]?.tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(writer.chunks).toEqual(['data: {"frame":"ping"}\n\n']);
  });

  test("adding a second writer does not start a second timer", () => {
    const { calls, every } = fakeEvery();
    const core = createStreamCore({ every });
    core.add(new FakeWriter());
    core.add(new FakeWriter());

    expect(calls).toHaveLength(1);
  });

  test("removing the last writer cancels the timer", () => {
    const { every, cancelled } = fakeEvery();
    const core = createStreamCore({ every });
    const remove = core.add(new FakeWriter());
    const removeSecond = core.add(new FakeWriter());

    remove();
    expect(cancelled()).toBe(0);
    removeSecond();
    expect(cancelled()).toBe(1);
    expect(core.size()).toBe(0);
  });
});
