/** A host-wide queue: all guest HTTP reads rotate the same cookie, including images.
 * Keep join + WebSocket admission together; room renewal uses its stable server reference. */
export class GuestHttp {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
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
