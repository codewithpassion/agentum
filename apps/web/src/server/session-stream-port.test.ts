import { expect, test } from "bun:test";
import type { StreamFrame } from "@repo/protocol/stream";
import type { SessionStream } from "./session-stream.ts";
import { streamPublisher } from "./session-stream-port.ts";

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
