import { DurableObject } from "cloudflare:workers";
import {
  type DesktopClipboardSetRequest,
  type DesktopInputRequest,
  type DesktopScreenshotRequest,
  type ExecRequest,
  type FileGetRequest,
  type FilePutRequest,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
} from "@repo/protocol/computer";
import type {
  ComputerOutcome,
  ComputerPrincipal,
  ComputerStatus,
  TakeHumanLeaseOutcome,
} from "@repo/services/machines/types";
import { compose } from "./compose.ts";
import {
  createMachineRelayCore,
  type MachineRelayCore,
} from "./machine-relay-core.ts";
import {
  RELAY_HEADER_MACHINE_ID,
  RELAY_HEADER_ROLE,
  RELAY_HEADER_VIEWER_USER,
  RELAY_HEADER_WORKSPACE_ID,
  RELAY_ROLES,
  type RelayRole,
} from "./relay-core.ts";

const UPGRADE_REQUIRED = 426;
const BAD_REQUEST = 400;
const SWITCHING_PROTOCOLS = 101;

const isRelayRole = (value: string | null): value is RelayRole =>
  RELAY_ROLES.some((role) => role === value);

/**
 * One Durable Object per machine (`idFromName(machineId)`), not one per role.
 * It holds every socket of the machine, tagged by who is on the other end:
 * `daemon` (agent host), `computer` (the computer client) and `viewer`
 * (people watching the desktop). One object gives the machine one identity and
 * one presence, and one `revoke` closes every socket. The viewer hub pumps
 * frames out of the computer socket, so it needs that socket in the same
 * object. Adding a class for the computer would need a wrangler migration, and
 * the hub would reach the socket across objects. To reverse the decision,
 * split off a `ComputerRelay` class only if one object's single-threaded loop
 * becomes the bottleneck for a machine's frames. (Decided in V6.1, see
 * docs/reviews/tasks/V6.1.md.)
 *
 * The daemon dials `/api/machines/connect` and the computer client
 * `/api/machines/computer`. Each route checks the credential for its role and
 * hands the upgrade here with the machine's identity and the role in headers
 * only the Worker can set. A person watching the desktop opens
 * `/api/machines/:id/desktop/stream`, which checks their Clerk session and
 * hands the upgrade here as role `viewer`, with their user id in a header of
 * the same kind. The socket is accepted with the hibernation API
 * under the role as its tag, so an idle machine costs nothing and survives
 * this object being evicted: identity, the computer's hello and the desktop
 * lease live in durable storage. A computer's bare `ping` is answered by the
 * platform (`setWebSocketAutoResponse`, one pair per object) without waking
 * this object. The daemon's heartbeat is a JSON frame, never a bare `ping`.
 *
 * The logic is in `machine-relay-core.ts`, which hands each socket to the
 * core for its tag (`relay-core.ts` for the daemon, `computer-relay-core.ts`
 * for the computer). This class is the part only a real Worker can run: the
 * socket pair, and the calls the runtime makes.
 */
export class MachineRelay extends DurableObject<Env> {
  #core: MachineRelayCore<WebSocket> | undefined;

  #relay(): MachineRelayCore<WebSocket> {
    this.#core ??= createMachineRelayCore<WebSocket>({
      background: (work) => this.ctx.waitUntil(work),
      heartbeatAt: (socket) =>
        this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? null,
      machines: compose(this.env, import.meta.env.DEV).services.machines,
      now: Date.now,
      sockets: () => this.ctx.getWebSockets(),
      storage: this.ctx.storage,
      tagsOf: (socket) => this.ctx.getTags(socket),
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
    const role = request.headers.get(RELAY_HEADER_ROLE);
    if (!(machineId && workspaceId)) {
      return new Response("No machine identity.", { status: BAD_REQUEST });
    }
    if (!isRelayRole(role)) {
      return new Response("No relay role.", { status: BAD_REQUEST });
    }
    if (role === "viewer") {
      return this.#acceptViewer(request.headers.get(RELAY_HEADER_VIEWER_USER));
    }
    const { generation } = await this.#relay().connect(role, {
      machineId,
      workspaceId,
    });
    // biome-ignore lint/correctness/noUndeclaredVariables: WebSocketPair is a Workers runtime global
    const pair = new WebSocketPair();
    // biome-ignore lint/style/useDestructuring: WebSocketPair is an indexed object, not an iterable
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [role]);
    if (role === "computer") {
      this.ctx.setWebSocketAutoResponse(
        // biome-ignore lint/correctness/noUndeclaredVariables: WebSocketRequestResponsePair is a Workers runtime global
        new WebSocketRequestResponsePair(HEARTBEAT_PING, HEARTBEAT_PONG)
      );
    }
    await this.#relay().accepted(role, server, generation);
    return new Response(null, {
      status: SWITCHING_PROTOCOLS,
      webSocket: pair[0],
    });
  }

  /** A person's socket: frames go out and input comes in. Needs no connect, generation or heartbeat. */
  #acceptViewer(userId: string | null): Response {
    if (!userId) {
      return new Response("No viewer.", { status: BAD_REQUEST });
    }
    // biome-ignore lint/correctness/noUndeclaredVariables: WebSocketPair is a Workers runtime global
    const pair = new WebSocketPair();
    // biome-ignore lint/style/useDestructuring: WebSocketPair is an indexed object, not an iterable
    const server = pair[1];
    this.ctx.acceptWebSocket(server, ["viewer"]);
    this.#relay().acceptViewer(server, userId);
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
    this.#relay().daemon.offer(run);
    return Promise.resolve();
  }

  announce(paths: string[]): Promise<void> {
    this.#relay().daemon.announce(paths);
    return Promise.resolve();
  }

  cancelRun(runId: string): Promise<void> {
    this.#relay().daemon.cancel(runId);
    return Promise.resolve();
  }

  /** Closes every socket of the machine with 4401, whatever its tag. */
  revoke(): Promise<void> {
    this.#relay().revoke();
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(4401, "Credential rejected.");
      } catch {
        // Already closing.
      }
    }
    return Promise.resolve();
  }

  computerExec(
    principal: ComputerPrincipal,
    input: Omit<ExecRequest, "op">
  ): Promise<ComputerOutcome> {
    return this.#relay().computer.exec(principal, input);
  }

  filePut(
    principal: ComputerPrincipal,
    input: Omit<FilePutRequest, "op">
  ): Promise<ComputerOutcome> {
    return this.#relay().computer.filePut(principal, input);
  }

  fileGet(
    principal: ComputerPrincipal,
    input: Omit<FileGetRequest, "op">
  ): Promise<ComputerOutcome> {
    return this.#relay().computer.fileGet(principal, input);
  }

  desktopScreenshot(
    principal: ComputerPrincipal,
    input: Omit<DesktopScreenshotRequest, "op">
  ): Promise<ComputerOutcome> {
    return this.#relay().computer.desktopScreenshot(principal, input);
  }

  desktopInput(
    principal: ComputerPrincipal,
    input: Omit<DesktopInputRequest, "op">
  ): Promise<ComputerOutcome> {
    return this.#relay().computer.desktopInput(principal, input);
  }

  clipboardGet(principal: ComputerPrincipal): Promise<ComputerOutcome> {
    return this.#relay().computer.clipboardGet(principal);
  }

  clipboardSet(
    principal: ComputerPrincipal,
    input: Omit<DesktopClipboardSetRequest, "op">
  ): Promise<ComputerOutcome> {
    return this.#relay().computer.clipboardSet(principal, input);
  }

  takeHumanLease(userId: string): Promise<TakeHumanLeaseOutcome> {
    return this.#relay().computer.takeHumanLease(userId);
  }

  releaseHumanLease(
    userId: string
  ): Promise<{ clipboardCleared: boolean; released: boolean }> {
    return this.#relay().computer.releaseHumanLease(userId);
  }

  computerStatus(): Promise<ComputerStatus> {
    return this.#relay().computer.status();
  }
}
