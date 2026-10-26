import { expect, test } from "bun:test";
import type { StreamFrame } from "@repo/protocol/stream";
import type { EventRecord } from "@repo/services/events";
import type { SessionStream } from "./session-stream.ts";
import {
  type SessionStreamPort,
  streamListener,
  streamPublisher,
} from "./session-stream-port.ts";

const frameOf = (runId: string): StreamFrame => ({
  frame: "run",
  runId,
  status: "running",
});

/** A namespace whose first publish is slower than the ones after it. */
const slowFirst = (arrived: string[]) => {
  let calls = 0;
  const stub = {
    publish: async (frame: StreamFrame) => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      arrived.push(frame.frame === "run" ? frame.runId : frame.frame);
    },
  };
  return {
    get: () => stub,
    idFromName: (name: string) => name,
  } as unknown as DurableObjectNamespace<SessionStream>;
};

test("deferred publishes reach the Durable Object in the order they were made", async () => {
  const arrived: string[] = [];
  const work: Promise<void>[] = [];
  const port = streamPublisher(slowFirst(arrived), (promise) => {
    work.push(promise);
  });

  await port.publish("s1", frameOf("first"));
  await port.publish("s1", frameOf("second"));
  await port.publish("s1", frameOf("third"));
  await Promise.all(work);

  expect(arrived).toEqual(["first", "second", "third"]);
});

test("a publish that throws is logged and does not reject", async () => {
  const namespace = {
    get: () => ({
      publish: () => Promise.reject(new Error("down")),
    }),
    idFromName: (name: string) => name,
  } as unknown as DurableObjectNamespace<SessionStream>;
  const port = streamPublisher(namespace);
  const original = console.error;
  console.error = () => undefined;
  try {
    await expect(port.publish("s1", frameOf("a"))).resolves.toBeUndefined();
  } finally {
    console.error = original;
  }
});

/** A port that records each (name, frame) pair it is asked to publish. */
const recordingPort = () => {
  const sent: [string, StreamFrame][] = [];
  const port: SessionStreamPort = {
    publish: (name, frame) => {
      sent.push([name, frame]);
      return Promise.resolve();
    },
  };
  return { port, sent };
};

const eventOf = (overrides: Partial<EventRecord>): EventRecord => ({
  actor: { id: "u1", kind: "user" },
  agentId: null,
  createdAt: "2026-10-26T00:00:00.000Z",
  id: "e1",
  payload: {},
  payloadRef: null,
  runId: "r1",
  seq: 1,
  sessionId: "s1",
  type: "run.started",
  workspaceId: "w1",
  ...overrides,
});

test("a run.started event goes to its session and then to the desk stream", async () => {
  const { port, sent } = recordingPort();
  await streamListener(port)(eventOf({ type: "run.started" }));

  const expected: StreamFrame[] = [
    {
      actor: { id: "u1", kind: "user" },
      createdAt: "2026-10-26T00:00:00.000Z",
      frame: "event",
      id: "e1",
      payload: {},
      runId: "r1",
      seq: 1,
      type: "run.started",
    },
    { frame: "run", runId: "r1", status: "running" },
  ];
  expect(sent).toEqual([
    ...expected.map((frame): [string, StreamFrame] => ["s1", frame]),
    ...expected.map((frame): [string, StreamFrame] => ["desk:w1", frame]),
  ]);
});

test("a message.user event goes to its session only", async () => {
  const { port, sent } = recordingPort();
  await streamListener(port)(eventOf({ runId: null, type: "message.user" }));

  expect(sent.map(([name]) => name)).toEqual(["s1"]);
});

test("an event outside a session publishes nothing", async () => {
  const { port, sent } = recordingPort();
  await streamListener(port)(eventOf({ sessionId: null }));

  expect(sent).toEqual([]);
});
