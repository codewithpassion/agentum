/**
 * Connect mode: the daemon dials out to Agentum and answers requests that
 * arrive over the socket. This is what makes a self-hosted computer work on a
 * laptop behind NAT - no inbound port, no tunnel, no public IP - and it is the
 * reason the token travels in the other direction from listen mode: here the
 * daemon presents it, once, at connect time.
 *
 * The socket is expected to break. A deploy, a laptop lid, a Durable Object
 * eviction all end it, so the loop below reconnects forever with backoff and
 * says so on stdout, which is where whoever started the container will look.
 */

import { hostname } from "node:os";
import type { Handle } from "./handlers";
import { log } from "./log";
import { VERSION } from "./version";

/** Answered with `heartbeat_ack`, which tells the host it is still there. */
const HEARTBEAT_MS = 30_000;

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 60_000;

/** Past this the doubling has already reached the ceiling; `2 ** 40` overflows nothing but is pointless. */
const MAX_BACKOFF_STEPS = 16;

export interface ConnectOptions {
  /** First reconnect delay; doubles up to `maxDelayMs`. */
  baseDelayMs?: number;
  handle: Handle;
  maxDelayMs?: number;
  /** The host token; presented as `Authorization: Bearer <token>`. */
  token: string;
  /** The Agentum base URL, http(s); the socket URL is derived from it. */
  url: string;
}

export interface ConnectClient {
  stop: () => void;
}

/**
 * `wss` for `https`, `ws` for anything else - a local dev server on
 * `http://localhost:3720` has to work as well as production.
 */
export const socketUrl = (base: string): string => {
  const url = new URL("/api/computer-hosts/connect", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const startConnectClient = (options: ConnectOptions): ConnectClient => {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const ceiling = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const url = socketUrl(options.url);

  let stopped = false;
  let attempt = 0;
  let socket: WebSocket | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const stopHeartbeat = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const backoffMs = (): number => {
    const step = Math.min(attempt, MAX_BACKOFF_STEPS);
    const ceilingForStep = Math.min(base * 2 ** step, ceiling);
    // Jitter, so a fleet of daemons that lost the same deployment does not come
    // back in lockstep.
    return Math.round(ceilingForStep * (0.5 + Math.random() / 2));
  };

  const onMessage = async (ws: WebSocket, data: unknown) => {
    if (typeof data !== "string") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      log("ignored a frame that was not JSON");
      return;
    }
    // Control frames - `heartbeat_ack` today - carry `type` instead of `op`.
    if (isRecord(parsed) && typeof parsed.type === "string") {
      return;
    }

    const response = await options.handle(parsed);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(response));
    }
  };

  const connect = () => {
    if (stopped) {
      return;
    }
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${options.token}` },
    });
    socket = ws;
    // `error` is usually followed by `close`, and a failed dial may raise only
    // one of them; whichever arrives first owns the reconnect.
    let settled = false;

    const ended = (why: string) => {
      if (settled) {
        return;
      }
      settled = true;
      stopHeartbeat();
      if (socket === ws) {
        socket = null;
      }
      if (stopped) {
        return;
      }
      const delay = backoffMs();
      attempt += 1;
      log(`disconnected (${why}); reconnecting in ${delay}ms`);
      retry = setTimeout(connect, delay);
    };

    ws.addEventListener("open", () => {
      attempt = 0;
      log(`connected to ${url}`);
      ws.send(
        JSON.stringify({
          hostname: hostname(),
          type: "hello",
          version: VERSION,
        })
      );
      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "heartbeat" }));
        }
      }, HEARTBEAT_MS);
    });

    ws.addEventListener("message", (event) => {
      onMessage(ws, event.data).catch((error: unknown) => {
        // A handler that throws must not take the connection down with it: the
        // sender is left waiting for that one id, and the socket stays usable.
        log(`failed to answer a request: ${String(error)}`);
      });
    });

    ws.addEventListener("error", () => {
      ended("error");
    });

    ws.addEventListener("close", (event) => {
      ended(`closed ${event.code}`);
    });
  };

  connect();

  return {
    stop() {
      stopped = true;
      stopHeartbeat();
      if (retry) {
        clearTimeout(retry);
        retry = null;
      }
      socket?.close();
      socket = null;
    },
  };
};
