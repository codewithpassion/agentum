// The logic of the SessionStream Durable Object, free of `cloudflare:workers`
// so bun can test it. It holds the open writers of one session, fans out each
// frame to all of them, pings on a timer and drops a writer whose write fails.
// Nothing is stored: stored events live in D1, deltas are ephemeral.
import type { StreamFrame } from "@repo/protocol/stream";

export const PING_INTERVAL_MS = 25_000;
/** Writes a client may leave unread before it is dropped as stalled. */
export const MAX_PENDING_WRITES = 100;

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
  maxPending = MAX_PENDING_WRITES,
  pingMs = PING_INTERVAL_MS,
}: {
  every: Every;
  maxPending?: number;
  pingMs?: number;
}) => {
  // Each writer with the number of its writes that have not finished.
  const writers = new Map<FrameWriter, number>();
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

  const send = (writer: FrameWriter, chunk: string): void => {
    const pending = (writers.get(writer) ?? 0) + 1;
    if (pending > maxPending) {
      // A client that stopped reading never fails a write, it only stops finishing them.
      drop(writer);
      return;
    }
    writers.set(writer, pending);
    writer
      .write(chunk)
      .catch(() => drop(writer))
      .finally(() => {
        const left = writers.get(writer);
        if (left !== undefined) {
          writers.set(writer, left - 1);
        }
      });
  };

  /**
   * Hands one frame to every writer and returns without waiting for the
   * writes, so a slow client never holds up the publisher. A writer whose
   * write fails, or that leaves too many writes unfinished, is dropped.
   */
  const publish = (frame: StreamFrame): Promise<void> => {
    const chunk = encodeFrame(frame);
    for (const writer of [...writers.keys()]) {
      send(writer, chunk);
    }
    return Promise.resolve();
  };

  /** Adds a writer and returns the function that removes it. */
  const add = (writer: FrameWriter): (() => void) => {
    writers.set(writer, 0);
    stopPing ??= every(pingMs, () => {
      publish({ frame: "ping" }).catch(() => undefined);
    });
    return () => drop(writer);
  };

  return { add, publish, size: () => writers.size };
};

export type StreamCore = ReturnType<typeof createStreamCore>;
