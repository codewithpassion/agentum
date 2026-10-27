import { type StreamFrame, streamFrameSchema } from "@repo/protocol/stream";

/** Incremental decoder: transport chunks need not align with SSE frames. */
export class GuestFrames {
  private buffer = "";
  push(chunk: string, receive: (frame: StreamFrame) => void) {
    this.buffer += chunk;
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      if (data) {
        const frame = streamFrameSchema.safeParse(JSON.parse(data));
        if (frame.success) {
          receive(frame.data);
        }
      }
      boundary = this.buffer.indexOf("\n\n");
    }
    if (this.buffer.length > 1_000_000) {
      throw new Error("Guest stream frame too large");
    }
  }
}
export const consumeGuestStream = async (
  response: Response,
  receive: (frame: StreamFrame) => void
) => {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }
  const frames = new GuestFrames();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: consume the incremental SSE body.
      const part = await reader.read();
      if (part.done) {
        return;
      }
      frames.push(decoder.decode(part.value, { stream: true }), receive);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
};
