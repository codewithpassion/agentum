import { describe, expect, test } from "bun:test";
import type { Timers, WebSocketFactory, WebSocketLike } from "./client.ts";
import type { DaemonConfig } from "./config.ts";
import { EXIT_OK } from "./exit-codes.ts";
import type { Logger } from "./log.ts";
import { runCommand, type SignalSubscribe } from "./run.ts";

const CONFIG: DaemonConfig = {
  claudeBinary: null,
  credential: "hm_mach_secret_for_tests",
  machineId: "mch_test",
  server: "https://harbour.example.com",
  singleUser: false,
};
const DAEMON_VERSION = "0.1.0-test";
const CONNECT_URL = "wss://harbour.example.com/api/machines/connect";
const HELLO_ACK = JSON.stringify({
  machineId: "mch_test",
  serverTime: "2026-10-16T10:00:00.000Z",
  type: "hello_ack",
});

const PENDING = Symbol("pending");
/** Resolves to PENDING while the promise has not settled. */
const peek = <T>(promise: Promise<T>) =>
  Promise.race<T | typeof PENDING>([promise, Promise.resolve(PENDING)]);

interface FakeSocket extends WebSocketLike {
  closed: boolean;
  fireClose: (code: number, reason?: string) => void;
  fireMessage: (data: unknown) => void;
  fireOpen: () => void;
  readonly headers: Record<string, string>;
  readonly url: string;
}

const fakeSockets = () => {
  const created: FakeSocket[] = [];
  const factory: WebSocketFactory = (url, options) => {
    // Like a hung relay: close() is recorded but never answered with a close event.
    const socket: FakeSocket = {
      close: () => {
        socket.closed = true;
      },
      closed: false,
      fireClose: (code, reason = "") => socket.onclose?.({ code, reason }),
      fireMessage: (data) => socket.onmessage?.({ data }),
      fireOpen: () => socket.onopen?.(),
      headers: options.headers,
      onclose: null,
      onerror: null,
      onmessage: null,
      onopen: null,
      send: () => undefined,
      url,
    };
    created.push(socket);
    return socket;
  };
  return { created, factory };
};

interface PendingTimer {
  readonly delay: number;
  readonly fn: () => void;
  readonly id: number;
  readonly kind: "after" | "every";
  readonly label: string;
}

const fakeTimers = () => {
  let nextId = 0;
  let pending: PendingTimer[] = [];

  const add = (
    kind: "after" | "every",
    delay: number,
    fn: () => void,
    label = ""
  ) => {
    nextId += 1;
    const timer: PendingTimer = { delay, fn, id: nextId, kind, label };
    pending.push(timer);
    return () => {
      pending = pending.filter((other) => other.id !== timer.id);
    };
  };

  const timers: Timers = {
    after: (ms, fn, label) => add("after", ms, fn, label),
    every: (ms, fn, label) => add("every", ms, fn, label),
  };

  const find = (label: string) => pending.find((t) => t.label === label);

  return { find, pending: () => pending, timers };
};

const fakeSignals = () => {
  let handler: (() => void) | null = null;
  let subscriptions = 0;
  let unsubscribes = 0;
  const subscribe: SignalSubscribe = (next) => {
    subscriptions += 1;
    handler = next;
    return () => {
      unsubscribes += 1;
      handler = null;
    };
  };
  return {
    counts: () => ({ subscriptions, unsubscribes }),
    fire: () => {
      if (handler === null) {
        throw new Error("no signal handler is subscribed");
      }
      handler();
    },
    subscribe,
  };
};

const setup = () => {
  const sockets = fakeSockets();
  const timers = fakeTimers();
  const signals = fakeSignals();
  const lines: string[] = [];
  const log: Logger = {
    error: (message) => {
      lines.push(message);
    },
    info: (message) => {
      lines.push(message);
    },
  };
  const done = runCommand({
    config: CONFIG,
    daemonVersion: DAEMON_VERSION,
    log,
    random: () => 0.5,
    signals: signals.subscribe,
    timers: timers.timers,
    wsFactory: sockets.factory,
  });
  return { done, lines, signals, sockets, timers };
};

const latest = (sockets: FakeSocket[]): FakeSocket => {
  const socket = sockets.at(-1);
  if (!socket) {
    throw new Error("no socket has been created");
  }
  return socket;
};

/** Opens the latest socket and gets it through hello_ack. */
const connectAndAck = (sockets: FakeSocket[]) => {
  const socket = latest(sockets);
  socket.fireOpen();
  socket.fireMessage(HELLO_ACK);
  return socket;
};

describe("runCommand", () => {
  test("connects to the relay with the bearer credential and stays pending while connected", async () => {
    const { done, lines, sockets } = setup();

    expect(sockets.created).toHaveLength(1);
    const socket = latest(sockets.created);
    expect(socket.url).toBe(CONNECT_URL);
    expect(socket.headers).toEqual({
      Authorization: `Bearer ${CONFIG.credential}`,
    });
    expect(lines).toContain(
      `running as machine ${CONFIG.machineId} against ${CONFIG.server}`
    );

    connectAndAck(sockets.created);
    expect(await peek(done)).toBe(PENDING);
  });

  test("a signal resolves with 0, closes the socket, and unsubscribes", async () => {
    const { done, signals, sockets } = setup();
    const socket = connectAndAck(sockets.created);

    signals.fire();

    expect(await done).toBe(EXIT_OK);
    expect(socket.closed).toBe(true);
    expect(signals.counts()).toEqual({ subscriptions: 1, unsubscribes: 1 });
  });

  test("a 4401 close resolves with 3 and nothing reconnects", async () => {
    const { done, signals, sockets, timers } = setup();
    connectAndAck(sockets.created).fireClose(4401, "Credential rejected.");

    expect(await done).toBe(3);
    expect(sockets.created).toHaveLength(1);
    expect(timers.find("reconnect")).toBeUndefined();
    expect(timers.pending()).toEqual([]);
    expect(signals.counts().unsubscribes).toBe(1);
  });

  test("a 1012 close does not resolve: a reconnect is scheduled and the promise stays pending", async () => {
    const { done, sockets, timers } = setup();
    connectAndAck(sockets.created).fireClose(1012, "Replaced");

    expect(timers.find("reconnect")).toBeDefined();
    expect(await peek(done)).toBe(PENDING);
  });

  test("an offer frame is logged without throwing, and the credential never reaches a log line", async () => {
    const { done, lines, sockets } = setup();
    const socket = connectAndAck(sockets.created);

    const offer = { agentId: "agt_1", runId: "run_1", type: "offer" };
    expect(() => socket.fireMessage(JSON.stringify(offer))).not.toThrow();
    expect(lines).toContain("offer for run run_1");

    socket.fireClose(4401, "Credential rejected.");
    expect(await done).toBe(3);
    expect(lines.some((line) => line.includes(CONFIG.credential))).toBe(false);
  });
});
