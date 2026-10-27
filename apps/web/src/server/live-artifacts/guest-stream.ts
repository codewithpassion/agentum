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
      return;
    }
    closed = true;
    clearInterval(timer);
    await reader.cancel().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    cancel: stop,
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
          await stop();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        await stop();
        controller.error(error);
      }
    },
    start(controller) {
      timer = setInterval(async () => {
        if (closed || checking) {
          return;
        }
        checking = true;
        try {
          if (!(await keep())) {
            await stop();
            controller.close();
          }
        } catch {
          await stop();
          controller.close();
        } finally {
          checking = false;
        }
      }, 2000);
    },
  });
};
