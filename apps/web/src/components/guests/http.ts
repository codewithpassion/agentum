/** A host-wide queue: all guest HTTP reads rotate the same cookie, including images.
 * Keep join + WebSocket admission together; room renewal uses its stable server reference. */
export class GuestHttp {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      // The host cookie is shared across tabs. Hold the browser lock through
      // response consumption and the initial socket admission barrier too.
      if (typeof navigator !== "undefined" && navigator.locks) {
        return await navigator.locks.request(
          "harbourmaster-guest-cookie",
          action
        );
      }
      return action();
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
  async response(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { Accept: "application/json", ...init?.headers },
    });
    if (!response.ok) {
      // Refusals still rotate the host cookie. Finish disposing the response
      // while holding its queue/lock, before a retry or navigation can start.
      await response.body?.cancel();
      throw new Error(
        response.status === 404 || response.status === 403
          ? "This invite has ended"
          : "Guest request failed. Please try again."
      );
    }
    return response;
  }
  json<T>(path: string, body?: unknown): Promise<T> {
    return this.run(
      async () =>
        (
          await this.response(
            path,
            body === undefined
              ? undefined
              : {
                  body: JSON.stringify(body),
                  headers: { "Content-Type": "application/json" },
                  method: "POST",
                }
          )
        ).json() as Promise<T>
    );
  }
}
export const guestHttp = new GuestHttp();
