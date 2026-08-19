import { DurableObject } from "cloudflare:workers";

const WEBSOCKET_UPGRADE_REQUIRED = 426;
const NORMAL_CLOSURE = 1000;

/**
 * One instance per channel (addressed with `idFromName(channelId)`). It only
 * fans out: the API writes to D1 and then calls `broadcast`, so a socket never
 * needs to be the source of truth. Uses the hibernation API, so idle channels
 * cost nothing.
 */
export class ChannelRoom extends DurableObject<Env> {
  override fetch(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", {
        status: WEBSOCKET_UPGRADE_REQUIRED,
      });
    }

    // biome-ignore lint/correctness/noUndeclaredVariables: WebSocketPair is a Workers runtime global
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Sends a serialized channel event to every connected client. */
  broadcast(payload: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // The socket went away between listing and sending; the runtime will
        // clean it up, and a client reload re-fetches the message list anyway.
      }
    }
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    // The only client-to-server traffic is a keepalive.
    if (message === "ping") {
      socket.send("pong");
    }
  }

  override webSocketClose(socket: WebSocket) {
    socket.close(NORMAL_CLOSURE, "Channel socket closed.");
  }
}
