import { encodeFrame } from "../session-stream-core";
import { eventFrame, STREAM_EVENT_TYPES } from "../session-stream-frames";
/** Revalidate idle as well as active streams; cancellation tears down the
 * SessionStream subscription. A stable server-side session reference survives
 * ordinary HTTP cookie rotation without extending the session's expiry. */
export const guestStream = (
  source: ReadableStream<Uint8Array>,
  keep: () => Promise<boolean>
) => {
  const reader = source.getReader();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let checking = false;
  const stop = async () => {
    if (closed) {
      return false;
    }
    closed = true;
    clearInterval(timer);
    await reader.cancel().catch(() => undefined);
    return true;
  };
  return new ReadableStream<Uint8Array>({
    cancel: async () => {
      await stop();
    },
    async pull(controller) {
      if (closed) {
        return;
      }
      try {
        const result = await reader.read();
        if (closed) {
          return;
        }
        if (result.done || !(await keep())) {
          if (await stop()) {
            controller.close();
          }
          return;
        }
        if (!closed) {
          controller.enqueue(result.value);
        }
      } catch (error) {
        if (await stop()) {
          controller.error(error);
        }
      }
    },
    start(controller) {
      timer = setInterval(async () => {
        if (closed || checking) {
          return;
        }
        checking = true;
        try {
          if (!(await keep()) && (await stop())) {
            controller.close();
          }
        } catch {
          if (await stop()) {
            controller.close();
          }
        } finally {
          checking = false;
        }
      }, 2000);
    },
  });
};

/** Subscribe first, replay every bounded page, then suppress duplicate live
 * frames. Authorization is repeated by transcript() for each page. */
export const guestReplay = async (
  scoped: Pick<
    ReturnType<
      typeof import("@repo/services/live-guests/artifacts").createGuestArtifacts
    >,
    "transcript"
  >,
  credential: import("@repo/services/live-guests/artifacts").GuestCredential,
  after: string | undefined
) => {
  const replay = { ids: new Set<string>(), text: "" };
  if (!after) {
    return replay;
  }
  let cursor = after;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: each page follows the prior cursor and revalidates access.
    const page = await scoped.transcript(credential, cursor);
    for (const event of page.events) {
      replay.ids.add(event.id);
      if (STREAM_EVENT_TYPES.some((type) => type === event.type)) {
        replay.text += encodeFrame(eventFrame(event));
      }
    }
    if (page.events.length < 100) {
      return replay;
    }
    if (replay.ids.size >= 10_000) {
      throw new Error("Guest replay exceeds limit");
    }
    cursor = page.events.at(-1)?.id ?? cursor;
  }
};
