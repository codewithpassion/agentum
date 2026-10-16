/**
 * Bun's global `WebSocket` adapted to `WebSocketLike`. Bun accepts a `headers`
 * option, which is how the daemon presents its credential as a bearer; the
 * browser API cannot do this.
 */

import type { WebSocketFactory, WebSocketLike } from "./client.ts";

export const bunWebSocketFactory: WebSocketFactory = (url, options) => {
  const socket = new WebSocket(url, { headers: options.headers });
  const like: WebSocketLike = {
    close: (code, reason) => socket.close(code, reason),
    onclose: null,
    onerror: null,
    onmessage: null,
    onopen: null,
    send: (data) => socket.send(data),
  };
  socket.onopen = () => like.onopen?.();
  socket.onclose = (event) =>
    like.onclose?.({ code: event.code, reason: event.reason });
  socket.onerror = (error) => like.onerror?.(error);
  socket.onmessage = (event) => like.onmessage?.({ data: event.data });
  return like;
};
