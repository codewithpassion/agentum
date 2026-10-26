// The SessionStream Durable Object (`idFromName(sessionId)`). It holds the open
// SSE connections of one session in memory only, and it is named by session id
// so every viewer of a session reaches the same object. Nothing is stored here:
// stored events live in D1, and deltas are ephemeral.
//
// The logic is in `session-stream-core.ts`. This class is the part only a real
// Worker can run: the timer and the streams.
import { DurableObject } from "cloudflare:workers";
import type { StreamFrame } from "@repo/protocol/stream";
import { createStreamCore, type FrameWriter } from "./session-stream-core.ts";

export class SessionStream extends DurableObject<Env> {
  readonly #core = createStreamCore({
    every: (ms, tick) => {
      const timer = setInterval(tick, ms);
      return () => clearInterval(timer);
    },
  });

  /** Sends one frame to every open stream of this session. */
  publish(frame: StreamFrame): Promise<void> {
    return this.#core.publish(frame);
  }

  override fetch(request: Request): Response {
    const { readable, writable } = new TransformStream<
      Uint8Array,
      Uint8Array
    >();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const frameWriter: FrameWriter = {
      close: () => {
        writer.close().catch(() => undefined);
      },
      write: (chunk) => writer.write(encoder.encode(chunk)),
    };
    const remove = this.#core.add(frameWriter);
    request.signal.addEventListener("abort", remove);

    return new Response(readable, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "Content-Type": "text/event-stream",
        "X-Accel-Buffering": "no",
      },
    });
  }
}
