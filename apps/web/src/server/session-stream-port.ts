// The services' view of the live stream: one SessionStream Durable Object per
// session, named by session id. The listener turns each stored event into its
// frames and publishes them in order. A failing publish is logged and never
// fails the append that stored the event.
import type { StreamFrame } from "@repo/protocol/stream";
import type { EventRecord } from "@repo/services/events";
import type { SessionStream } from "./session-stream.ts";
import { framesOf } from "./session-stream-frames.ts";

export interface SessionStreamPort {
  publish: (sessionId: string, frame: StreamFrame) => Promise<void>;
}

/**
 * The port over the SessionStream namespace. With `defer`, the publish is
 * handed to it and the call returns at once. Without it, the call awaits.
 */
export const streamPublisher = (
  namespace: DurableObjectNamespace<SessionStream>,
  defer?: (work: Promise<void>) => void
): SessionStreamPort => {
  const send = async (sessionId: string, frame: StreamFrame): Promise<void> => {
    try {
      await namespace.get(namespace.idFromName(sessionId)).publish(frame);
    } catch (error) {
      console.error("Session stream publish failed", error);
    }
  };
  return {
    publish: async (sessionId, frame) => {
      const work = send(sessionId, frame);
      if (defer) {
        defer(work);
        return;
      }
      await work;
    },
  };
};

/** Publishes the frames of each stored event, in order. Events outside a session publish nothing. */
export const streamListener =
  (port: SessionStreamPort) =>
  async (event: EventRecord): Promise<void> => {
    const { sessionId } = event;
    if (sessionId === null) {
      return;
    }
    try {
      for (const frame of framesOf(event)) {
        // biome-ignore lint/performance/noAwaitInLoops: frames of one event go out in order
        await port.publish(sessionId, frame);
      }
    } catch (error) {
      console.error("Session stream listener failed", error);
    }
  };
