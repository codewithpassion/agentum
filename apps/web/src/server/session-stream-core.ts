// The logic of the SessionStream Durable Object, free of `cloudflare:workers`
// so bun can test it. It holds the open writers of one session, fans out each
// frame to all of them, pings on a timer and drops a writer whose write fails.
// Nothing is stored: stored events live in D1, deltas are ephemeral.
import type { StreamFrame } from "@repo/protocol/stream";

export const PING_INTERVAL_MS = 25_000;

/** One open SSE connection. `write` rejects once the client is gone. */
export interface FrameWriter {
  close: () => void;
  write: (chunk: string) => Promise<void>;
}

/** Calls `tick` every `ms` until the returned function is called. */
export type Every = (ms: number, tick: () => void) => () => void;

/**
 * A frame as SSE text. Only `event` frames carry an `id:`, so `Last-Event-ID`
 * resumes on stored events only. The frame itself rides in `data:`.
 */
export const encodeFrame = (frame: StreamFrame): string =>
  frame.frame === "event"
    ? `id: ${frame.id}\ndata: ${JSON.stringify(frame)}\n\n`
    : `data: ${JSON.stringify(frame)}\n\n`;

export const createStreamCore = ({
  every,
  pingMs = PING_INTERVAL_MS,
}: {
  every: Every;
  pingMs?: number;
}) => {
  const writers = new Set<FrameWriter>();
  let stopPing: (() => void) | undefined;

  const drop = (writer: FrameWriter): void => {
    if (!writers.delete(writer)) {
      return;
    }
    try {
      writer.close();
    } catch {
      // Already closed.
    }
    if (writers.size === 0) {
      stopPing?.();
      stopPing = undefined;
    }
  };

  /** Sends one frame to every writer. A writer whose write fails is dropped. */
  const publish = async (frame: StreamFrame): Promise<void> => {
    const chunk = encodeFrame(frame);
    await Promise.all(
      [...writers].map(async (writer) => {
        try {
          await writer.write(chunk);
        } catch {
          drop(writer);
        }
      })
    );
  };

  /** Adds a writer and returns the function that removes it. */
  const add = (writer: FrameWriter): (() => void) => {
    writers.add(writer);
    stopPing ??= every(pingMs, () => {
      publish({ frame: "ping" }).catch(() => undefined);
    });
    return () => drop(writer);
  };

  return { add, publish, size: () => writers.size };
};

export type StreamCore = ReturnType<typeof createStreamCore>;
