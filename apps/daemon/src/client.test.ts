import { describe, expect, test } from "bun:test";
import { daemonFrameSchema } from "@repo/protocol/machine";
import {
  buildConnectUrl,
  createDaemonClient,
  STABLE_MS,
  type Timers,
  type WebSocketFactory,
  type WebSocketLike,
} from "./client.ts";
import { collectingLogger } from "./log.ts";

const SERVER = "https://harbour.example.com/";
const CREDENTIAL = "hm_mach_test";
const DAEMON_VERSION = "0.1.0-test";

interface FakeSocket extends WebSocketLike {
  closed: boolean;
  fireClose: (code: number, reason?: string) => void;
  fireError: () => void;
  fireMessage: (data: unknown) => void;
  fireOpen: () => void;
  readonly headers: Record<string, string>;
  readonly sent: string[];
  readonly url: string;
}

const fakeSockets = () => {
  const created: FakeSocket[] = [];
  const factory: WebSocketFactory = (url, options) => {
    const sent: string[] = [];
    // Like a hung relay: close() is recorded but never answered with a close event.
    const socket: FakeSocket = {
      close: () => {
        socket.closed = true;
      },
      closed: false,
      fireClose: (code, reason = "") => socket.onclose?.({ code, reason }),
      fireError: () => socket.onerror?.(),
      fireMessage: (data) => socket.onmessage?.({ data }),
      fireOpen: () => socket.onopen?.(),
      headers: options.headers,
      onclose: null,
      onerror: null,
      onmessage: null,
      onopen: null,
      send: (data) => {
        sent.push(data);
      },
      sent,
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

  /** Runs the pending timer with this label. A one-shot timer is removed first. */
  const fire = (label: string) => {
    const timer = find(label);
    if (!timer) {
      throw new Error(`no pending timer labelled ${label}`);
    }
    if (timer.kind === "after") {
      pending = pending.filter((other) => other.id !== timer.id);
    }
    timer.fn();
  };

  return { find, fire, pending: () => pending, timers };
};

const HELLO_ACK = JSON.stringify({
  machineId: "mch_test",
  serverTime: "2026-10-16T10:00:00.000Z",
  type: "hello_ack",
});

const setup = () => {
  const sockets = fakeSockets();
  const timers = fakeTimers();
  const lines: string[] = [];
  const frames: unknown[] = [];
  const stops: number[] = [];
  const client = createDaemonClient({
    credential: CREDENTIAL,
    daemonVersion: DAEMON_VERSION,
    log: collectingLogger(lines),
    onFrame: (frame) => {
      frames.push(frame);
    },
    onStop: (exitCode) => {
      stops.push(exitCode);
    },
    random: () => 0.5,
    server: SERVER,
    timers: timers.timers,
    wsFactory: sockets.factory,
  });
  return { client, frames, lines, sockets, stops, timers };
};

const latest = (sockets: FakeSocket[]): FakeSocket => {
  const socket = sockets.at(-1);
  if (!socket) {
    throw new Error("no socket has been created");
  }
  return socket;
};

const reconnectDelay = (timers: ReturnType<typeof fakeTimers>) =>
  timers.find("reconnect")?.delay;

/** Opens the latest socket and gets it through hello_ack. */
const connectAndAck = (sockets: FakeSocket[]) => {
  const socket = latest(sockets);
  socket.fireOpen();
  socket.fireMessage(HELLO_ACK);
  return socket;
};

describe("buildConnectUrl", () => {
  test("switches http to ws and https to wss, with the connect path", () => {
    expect(buildConnectUrl("https://harbour.example.com/")).toBe(
      "wss://harbour.example.com/api/machines/connect"
    );
    expect(buildConnectUrl("http://localhost:3000///")).toBe(
      "ws://localhost:3000/api/machines/connect"
    );
  });
});

describe("connection", () => {
  test("connects with the bearer header, sends hello on open, pings every 20s", () => {
    const { client, sockets, timers } = setup();
    client.start();

    const socket = latest(sockets.created);
    expect(socket.url).toBe("wss://harbour.example.com/api/machines/connect");
    expect(socket.headers).toEqual({ Authorization: `Bearer ${CREDENTIAL}` });
    expect(socket.sent).toEqual([]);

    socket.fireOpen();
    const hello = JSON.parse(socket.sent[0] ?? "null");
    expect(daemonFrameSchema.safeParse(hello).success).toBe(true);
    expect(hello).toEqual({
      agents: [],
      capabilities: { agentSdk: "none", container: false },
      daemonVersion: DAEMON_VERSION,
      type: "hello",
    });

    const ping = timers.find("ping");
    expect(ping?.delay).toBe(20_000);
    timers.fire("ping");
    const pingFrame = JSON.parse(socket.sent[1] ?? "null");
    expect(daemonFrameSchema.safeParse(pingFrame).success).toBe(true);
    expect(pingFrame.type).toBe("ping");
  });

  test("hello_ack alone does not reset the backoff, a stable connection does", () => {
    const { client, sockets, timers } = setup();
    client.start();

    connectAndAck(sockets.created).fireClose(1006);
    expect(reconnectDelay(timers)).toBe(1000);
    timers.fire("reconnect");

    connectAndAck(sockets.created).fireClose(1006);
    expect(reconnectDelay(timers)).toBe(2000);
    timers.fire("reconnect");

    connectAndAck(sockets.created);
    expect(timers.find("stable")?.delay).toBe(STABLE_MS);
    timers.fire("stable");
    latest(sockets.created).fireClose(1006);
    expect(reconnectDelay(timers)).toBe(1000);
  });

  test("a close before the stable timer cancels it", () => {
    const { client, sockets, timers } = setup();
    client.start();

    connectAndAck(sockets.created).fireClose(1006);
    expect(timers.find("stable")).toBeUndefined();
  });

  test("a 1012 close schedules a reconnect that opens a second socket", () => {
    const { client, sockets, timers } = setup();
    client.start();

    connectAndAck(sockets.created).fireClose(1012, "Replaced");
    expect(reconnectDelay(timers)).toBe(1000);
    timers.fire("reconnect");

    expect(sockets.created).toHaveLength(2);
    expect(latest(sockets.created).url).toBe(
      "wss://harbour.example.com/api/machines/connect"
    );
  });

  test("a 4401 close stops for good with exit code 3 and leaves no timers", () => {
    const { client, sockets, stops, timers } = setup();
    client.start();

    connectAndAck(sockets.created).fireClose(4401, "Credential rejected.");

    expect(stops).toEqual([3]);
    expect(timers.find("reconnect")).toBeUndefined();
    expect(timers.pending()).toEqual([]);
    expect(sockets.created).toHaveLength(1);
  });

  test("no reconnect storm: repeated 1006 closes back off without resetting", () => {
    const { client, sockets, timers } = setup();
    client.start();

    const delays: (number | undefined)[] = [];
    for (let round = 0; round < 5; round += 1) {
      connectAndAck(sockets.created).fireClose(1006);
      delays.push(reconnectDelay(timers));
      timers.fire("reconnect");
    }

    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000]);
  });

  test("no hello_ack within 40s drops the socket and schedules a reconnect", () => {
    const { client, sockets, timers } = setup();
    client.start();

    const socket = latest(sockets.created);
    socket.fireOpen();
    expect(timers.find("ack")?.delay).toBe(40_000);

    timers.fire("ack");

    expect(socket.closed).toBe(true);
    expect(reconnectDelay(timers)).toBe(1000);
  });

  test("an error event schedules a reconnect like a close does", () => {
    const { client, sockets, timers } = setup();
    client.start();

    latest(sockets.created).fireError();

    expect(reconnectDelay(timers)).toBe(1000);
  });
});

describe("stop", () => {
  test("cancels every timer, closes the socket, and ignores a late close", () => {
    const { client, sockets, stops, timers } = setup();
    client.start();
    const first = connectAndAck(sockets.created);

    client.stop();

    expect(timers.pending()).toEqual([]);
    expect(first.closed).toBe(true);

    first.fireClose(1006);
    expect(timers.pending()).toEqual([]);
    expect(sockets.created).toHaveLength(1);
    expect(stops).toEqual([]);
  });

  test("start after stop connects again", () => {
    const { client, sockets } = setup();
    client.start();
    client.stop();

    client.start();

    expect(sockets.created).toHaveLength(2);
  });
});

describe("inbound frames", () => {
  test("an offer frame reaches onFrame", () => {
    const { client, frames, sockets } = setup();
    client.start();
    const socket = connectAndAck(sockets.created);

    const offer = { agentId: "agt_1", runId: "run_1", type: "offer" };
    socket.fireMessage(JSON.stringify(offer));

    expect(frames).toEqual([offer]);
  });

  test("garbage text and binary frames are dropped without throwing", () => {
    const { client, frames, lines, sockets } = setup();
    client.start();
    const socket = connectAndAck(sockets.created);

    expect(() => socket.fireMessage("not json")).not.toThrow();
    expect(() =>
      socket.fireMessage(JSON.stringify({ type: "nope" }))
    ).not.toThrow();
    expect(() => socket.fireMessage(new ArrayBuffer(4))).not.toThrow();

    expect(frames).toEqual([]);
    expect(lines.filter((line) => line.startsWith("dropping"))).toHaveLength(3);
  });
});
