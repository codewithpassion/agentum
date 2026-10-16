// The daemon's WebSocket client to the relay. Sockets and timers are injected,
// so the reconnect, ping and close-code logic is testable without real I/O.
// The relay never sends a pong: the socket is alive as long as the relay
// answers hello, and the relay itself times out a silent machine.

import {
  CLOSE_CODES,
  type DaemonHello,
  type DaemonPing,
  HEARTBEAT_SECONDS,
  type RelayFrame,
  relayFrameSchema,
} from "@repo/protocol/machine";
import { nextBackoffMs } from "./backoff.ts";
import { EXIT_CREDENTIAL_REJECTED } from "./exit-codes.ts";
import type { Logger } from "./log.ts";

const HEARTBEAT_MS = HEARTBEAT_SECONDS * 1000;
const ACK_TIMEOUT_MS = 2 * HEARTBEAT_MS;
/** A connection that stays up this long after hello_ack has proved itself. */
export const STABLE_MS = 30_000;

const TRAILING_SLASHES = /\/+$/;
const HTTP_SCHEME = /^http:/;
const HTTPS_SCHEME = /^https:/;

/** The minimal WebSocket surface the client uses, in browser-handler shape. */
export interface WebSocketLike {
  close: (code?: number, reason?: string) => void;
  onclose:
    | ((info?: { readonly code?: number; readonly reason?: string }) => void)
    | null;
  onerror: ((error?: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onopen: (() => void) | null;
  send: (data: string) => void;
}

export type WebSocketFactory = (
  url: string,
  options: { readonly headers: Record<string, string> }
) => WebSocketLike;

export type CancelFn = () => void;

/** `label` names the timer for tests and debugging; the real timers ignore it. */
export interface Timers {
  after: (ms: number, fn: () => void, label?: string) => CancelFn;
  every: (ms: number, fn: () => void, label?: string) => CancelFn;
}

export const realTimers: Timers = {
  after: (ms, fn) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
  every: (ms, fn) => {
    const handle = setInterval(fn, ms);
    return () => clearInterval(handle);
  },
};

/** `<server>/api/machines/connect`, with the scheme switched to ws or wss. */
export const buildConnectUrl = (server: string): string => {
  const base = server
    .replace(TRAILING_SLASHES, "")
    .replace(HTTP_SCHEME, "ws:")
    .replace(HTTPS_SCHEME, "wss:");
  return `${base}/api/machines/connect`;
};

export interface DaemonClientOptions {
  credential: string;
  daemonVersion: string;
  log: Logger;
  onFrame?: (frame: RelayFrame) => void;
  /** Called once when the relay ends the connection for good. */
  onStop: (exitCode: number) => void;
  random?: () => number;
  server: string;
  timers?: Timers;
  wsFactory: WebSocketFactory;
}

export interface DaemonClient {
  start: () => void;
  stop: () => void;
}

const parseRelayFrame = (text: string): RelayFrame | null => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = relayFrameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export const createDaemonClient = (
  options: DaemonClientOptions
): DaemonClient => {
  const { credential, daemonVersion, log, onFrame, onStop, wsFactory } =
    options;
  const timers = options.timers ?? realTimers;
  const random = options.random ?? Math.random;
  const url = buildConnectUrl(options.server);

  let ws: WebSocketLike | null = null;
  let open = false;
  // Only a connection that stays up for STABLE_MS after hello_ack resets this.
  // Resetting on open or on hello_ack would let two daemons sharing one
  // credential storm the relay, each replacing the other with 1012.
  let attempt = 0;
  let cancelReconnect: CancelFn | null = null;
  let cancelPing: CancelFn | null = null;
  let cancelAck: CancelFn | null = null;
  let cancelStable: CancelFn | null = null;

  const clearTimer = (cancel: CancelFn | null): null => {
    cancel?.();
    return null;
  };

  const clearAllTimers = () => {
    cancelReconnect = clearTimer(cancelReconnect);
    cancelPing = clearTimer(cancelPing);
    cancelAck = clearTimer(cancelAck);
    cancelStable = clearTimer(cancelStable);
  };

  const send = (frame: DaemonHello | DaemonPing) => {
    ws?.send(JSON.stringify(frame));
  };

  const sendPing = () => {
    if (!open) {
      return;
    }
    send({ at: new Date().toISOString(), type: "ping" });
  };

  const scheduleReconnect = () => {
    const delay = nextBackoffMs(attempt, random);
    attempt += 1;
    log.info(`reconnecting in ${delay}ms`);
    cancelReconnect = timers.after(
      delay,
      () => {
        cancelReconnect = null;
        connect();
      },
      "reconnect"
    );
  };

  const disconnect = (reason: string, code?: number, closeReason?: string) => {
    open = false;
    ws = null;
    clearAllTimers();
    const detail = [reason, code, closeReason].filter(Boolean).join(" ");
    log.info(`disconnected (${detail})`);

    if (code === CLOSE_CODES.credentialRejected) {
      log.error("credential rejected; enroll this machine again");
      onStop(EXIT_CREDENTIAL_REJECTED);
      return;
    }
    scheduleReconnect();
  };

  /**
   * Closes a socket that stopped answering. A hung relay never completes the
   * close handshake, so the disconnect is driven here as well.
   */
  const dropSocket = (reason: string) => {
    const socket = ws;
    if (socket === null) {
      return;
    }
    socket.close();
    if (ws === socket) {
      disconnect(reason);
    }
  };

  const onAckTimeout = () => {
    cancelAck = null;
    log.info("no hello_ack from the relay; dropping the socket");
    dropSocket("ack timeout");
  };

  const onHelloAck = (machineId: string) => {
    cancelAck = clearTimer(cancelAck);
    log.info(`registered as ${machineId}`);
    cancelStable = clearTimer(cancelStable);
    cancelStable = timers.after(
      STABLE_MS,
      () => {
        cancelStable = null;
        attempt = 0;
        log.info("connection stable; backoff reset");
      },
      "stable"
    );
  };

  const onMessage = (data: unknown) => {
    if (typeof data !== "string") {
      log.info("dropping a non-text frame");
      return;
    }
    const frame = parseRelayFrame(data);
    if (frame === null) {
      log.info("dropping an unparsable frame");
      return;
    }
    if (frame.type === "hello_ack") {
      onHelloAck(frame.machineId);
      return;
    }
    onFrame?.(frame);
  };

  const onOpen = () => {
    open = true;
    log.info("connected");
    send({
      agents: [],
      capabilities: { agentSdk: "none", container: false },
      daemonVersion,
      type: "hello",
    });
    cancelPing = timers.every(HEARTBEAT_MS, sendPing, "ping");
    cancelAck = timers.after(ACK_TIMEOUT_MS, onAckTimeout, "ack");
  };

  const connect = () => {
    log.info(`connecting to ${url}`);
    const socket = wsFactory(url, {
      headers: { Authorization: `Bearer ${credential}` },
    });
    ws = socket;
    // A socket we have already given up on must not tear down its successor:
    // Bun fires `onerror` and then `onclose` for one abnormal close.
    const current = () => ws === socket;
    socket.onopen = () => {
      if (current()) {
        onOpen();
      }
    };
    socket.onmessage = (event) => {
      if (current()) {
        onMessage(event.data);
      }
    };
    socket.onerror = () => {
      if (current()) {
        disconnect("error");
      }
    };
    socket.onclose = (info) => {
      if (current()) {
        disconnect("close", info?.code, info?.reason);
      }
    };
  };

  const stop = () => {
    clearAllTimers();
    const socket = ws;
    ws = null;
    open = false;
    socket?.close();
  };

  return {
    start: () => {
      connect();
    },
    stop,
  };
};
