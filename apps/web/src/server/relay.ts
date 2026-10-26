import { DurableObject } from "cloudflare:workers";
import { compose } from "./compose.ts";
import {
  createRelayCore,
  RELAY_HEADER_MACHINE_ID,
  RELAY_HEADER_WORKSPACE_ID,
  type RelayCore,
} from "./relay-core.ts";

const UPGRADE_REQUIRED = 426;
const BAD_REQUEST = 400;
const SWITCHING_PROTOCOLS = 101;

/**
 * One machine's socket (`idFromName(machineId)`), and the only thing that
 * holds it. The daemon dials `/api/machines/connect`, that route checks the
 * credential and hands the upgrade here with the machine's identity in two
 * headers only the Worker can set. The socket is accepted with the hibernation
 * API, so an idle machine costs nothing and survives this object being
 * evicted: identity and the last ping live in durable storage.
 *
 * The logic is in `relay-core.ts`. This class is the part only a real Worker
 * can run: the socket pair, and the calls the runtime makes.
 */
export class MachineRelay extends DurableObject<Env> {
  #core: RelayCore | undefined;

  #relay(): RelayCore {
    this.#core ??= createRelayCore({
      machines: compose(this.env, import.meta.env.DEV).services.machines,
      now: Date.now,
      sockets: () => this.ctx.getWebSockets(),
      storage: this.ctx.storage,
    });
    return this.#core;
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", {
        status: UPGRADE_REQUIRED,
      });
    }
    const machineId = request.headers.get(RELAY_HEADER_MACHINE_ID);
    const workspaceId = request.headers.get(RELAY_HEADER_WORKSPACE_ID);
    if (!(machineId && workspaceId)) {
      return new Response("No machine identity.", { status: BAD_REQUEST });
    }
    await this.#relay().connect({ machineId, workspaceId });
    // biome-ignore lint/correctness/noUndeclaredVariables: WebSocketPair is a Workers runtime global
    const pair = new WebSocketPair();
    // biome-ignore lint/style/useDestructuring: WebSocketPair is an indexed object, not an iterable
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, {
      status: SWITCHING_PROTOCOLS,
      webSocket: pair[0],
    });
  }

  override webSocketMessage(
    socket: WebSocket,
    message: ArrayBuffer | string
  ): Promise<void> {
    return this.#relay().message(socket, message);
  }

  override webSocketClose(socket: WebSocket): Promise<void> {
    return this.#relay().closed(socket);
  }

  override webSocketError(socket: WebSocket): Promise<void> {
    return this.#relay().closed(socket);
  }

  override alarm(): Promise<void> {
    return this.#relay().alarm();
  }

  // The calls below are RPC from the Worker, through `relay-port.ts`.

  offer(run: { agentId: string; runId: string }): Promise<void> {
    this.#relay().offer(run);
    return Promise.resolve();
  }

  announce(paths: string[]): Promise<void> {
    this.#relay().announce(paths);
    return Promise.resolve();
  }

  cancelRun(runId: string): Promise<void> {
    this.#relay().cancel(runId);
    return Promise.resolve();
  }

  revoke(): Promise<void> {
    this.#relay().revoke();
    return Promise.resolve();
  }
}
