import { describe, expect, test } from "bun:test";
import {
  ackMessage,
  type DesktopStatus,
  type DesktopStreamHandlers,
  desktopStreamPath,
  inputMessage,
  openDesktopStream,
  parseFrame,
  parseStreamMessage,
  problemFromCode,
  streamUrl,
} from "./desktop-stream.ts";

const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
const CLOSE_NORMAL = 1000;

class FakeSocket {
  binaryType = "blob";
  closedWith: number | null = null;
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  readyState = 0;
  readonly sent: string[] = [];
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(code: number) {
    this.closedWith = code;
  }
  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
  open() {
    this.readyState = SOCKET_OPEN;
    this.emit("open");
  }
  send(data: string) {
    this.sent.push(data);
  }
  shut() {
    this.readyState = SOCKET_CLOSED;
    this.emit("close");
  }
}

interface PendingTimer {
  cancelled: boolean;
  delay: number;
  run: () => void;
}

/** Records scheduled reconnects so a test runs them by hand. */
const fakeSchedule =
  (timers: PendingTimer[]) => (run: () => void, ms: number) => {
    const timer: PendingTimer = { cancelled: false, delay: ms, run };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };

const frameBuffer = (id: number, bytes: number[]): ArrayBuffer => {
  const buffer = new Uint8Array(4 + bytes.length);
  new DataView(buffer.buffer).setUint32(0, id);
  buffer.set(bytes, 4);
  return buffer.buffer;
};

interface Harness {
  calls: string[];
  /** Runs the oldest pending reconnect that was not cancelled. */
  runNextTimer: () => void;
  sockets: FakeSocket[];
  start: (options?: {
    hidden?: () => boolean;
  }) => ReturnType<typeof openDesktopStream>;
  timers: PendingTimer[];
}

const harness = (): Harness => {
  const calls: string[] = [];
  const sockets: FakeSocket[] = [];
  const timers: PendingTimer[] = [];
  const handlers: DesktopStreamHandlers = {
    onClosed: (wasOpen) => calls.push(`closed:${wasOpen}`),
    onFrame: () => calls.push("frame"),
    onInputError: (code) => calls.push(`input_error:${code}`),
    onOpen: () => calls.push("open"),
    onProblem: (problem) => calls.push(`problem:${problem.kind}`),
    onStatus: () => calls.push("status"),
  };
  return {
    calls,
    runNextTimer: () => {
      const timer = timers.find((pending) => !pending.cancelled);
      if (!timer) {
        throw new Error("no reconnect is pending");
      }
      timers.splice(timers.indexOf(timer), 1);
      timer.run();
    },
    sockets,
    start: (options = {}) =>
      openDesktopStream({
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
        handlers,
        isHidden: options.hidden ?? (() => false),
        schedule: fakeSchedule(timers),
        url: "wss://app.example/api/machines/m1/desktop/stream",
      }),
    timers,
  };
};

const status = {
  connected: true,
  control: null,
  desktop: true,
  desktopUnavailableReason: null,
  youHaveControl: false,
};

describe("message parsing", () => {
  test("a status message keeps the status fields", () => {
    const message = parseStreamMessage(
      JSON.stringify({ ...status, t: "status" })
    );

    expect(message).toEqual({ status, t: "status" });
  });

  test("a status message with a control and a reason keeps both", () => {
    const control: DesktopStatus["control"] = {
      expiresAt: 123,
      holder: { kind: "human", userId: "u1" },
    };
    const message = parseStreamMessage(
      JSON.stringify({
        ...status,
        control,
        desktop: false,
        desktopUnavailableReason: "no display",
        t: "status",
      })
    );

    expect(message).toEqual({
      status: {
        ...status,
        control,
        desktop: false,
        desktopUnavailableReason: "no display",
      },
      t: "status",
    });
  });

  test("a status message without control or a reason gets null for both", () => {
    const {
      control: _control,
      desktopUnavailableReason: _reason,
      ...rest
    } = status;
    const message = parseStreamMessage(
      JSON.stringify({ ...rest, t: "status" })
    );

    expect(message).toEqual({ status, t: "status" });
  });

  test("a status message with a wrong-typed flag is rejected", () => {
    expect(
      parseStreamMessage(
        JSON.stringify({ ...status, connected: "yes", t: "status" })
      )
    ).toBeNull();
    expect(
      parseStreamMessage(JSON.stringify({ ...status, desktop: 1, t: "status" }))
    ).toBeNull();
    expect(
      parseStreamMessage(
        JSON.stringify({ ...status, t: "status", youHaveControl: null })
      )
    ).toBeNull();
  });

  test("problem and error messages carry a code and a message", () => {
    expect(
      parseStreamMessage('{"t":"problem","code":"offline","message":"gone"}')
    ).toEqual({ code: "offline", message: "gone", t: "problem" });
    expect(parseStreamMessage('{"t":"error","code":"lease_required"}')).toEqual(
      {
        code: "lease_required",
        message: "",
        t: "error",
      }
    );
  });

  test.each([
    "nope",
    "[]",
    '{"t":"status"}',
    '{"t":"problem"}',
    '{"t":"wat","code":"x"}',
  ])("unreadable text %s is ignored", (raw) => {
    expect(parseStreamMessage(raw)).toBeNull();
  });

  test("a frame is its id then the JPEG; a header alone is no frame", () => {
    const frame = parseFrame(frameBuffer(258, [0xff, 0xd8]));
    expect(frame?.id).toBe(258);
    expect(
      Array.from(new Uint8Array(frame?.jpeg ?? new ArrayBuffer(0)))
    ).toEqual([0xff, 0xd8]);
    expect(parseFrame(new ArrayBuffer(4))).toBeNull();
  });

  test("outgoing messages have the shape the server reads", () => {
    expect(JSON.parse(ackMessage(7))).toEqual({ id: 7, t: "ack" });
    expect(JSON.parse(inputMessage([{ keys: "Return", type: "key" }]))).toEqual(
      {
        actions: [{ keys: "Return", type: "key" }],
        t: "input",
      }
    );
  });

  test("problem codes become the view's problems", () => {
    expect(problemFromCode("human_in_control", "")).toEqual({
      kind: "human_in_control",
    });
    expect(problemFromCode("clearing", "")).toEqual({ kind: "clearing" });
    expect(problemFromCode("offline", "")).toEqual({ kind: "offline" });
    expect(problemFromCode("desktop_unavailable", "no x")).toEqual({
      kind: "unavailable",
      message: "no x",
    });
    expect(problemFromCode("desktop_failed", "bad")).toEqual({
      kind: "failed",
      message: "bad",
    });
  });

  test("the stream url follows the page's scheme", () => {
    const base = { host: "app.example", pathname: "/s" };
    expect(streamUrl({ ...base, protocol: "https:" })).toBe(
      "wss://app.example/s"
    );
    expect(streamUrl({ ...base, protocol: "http:" })).toBe(
      "ws://app.example/s"
    );
  });

  test("the stream path encodes the machine id", () => {
    expect(desktopStreamPath("m 1/x")).toBe(
      "/api/machines/m%201%2Fx/desktop/stream"
    );
  });
});

describe("the stream connection", () => {
  test("frames are handed over and acked", () => {
    const { calls, sockets, start } = harness();
    const stream = start();
    sockets[0]?.open();

    sockets[0]?.emit("message", { data: frameBuffer(5, [1, 2]) });

    expect(calls).toEqual(["open", "frame"]);
    expect(sockets[0]?.sent).toEqual([ackMessage(5)]);
    expect(stream.isOpen()).toBe(true);
  });

  test("a hidden tab does not ack until it is visible again", () => {
    const { sockets, start } = harness();
    let hidden = true;
    start({ hidden: () => hidden });
    sockets[0]?.open();

    sockets[0]?.emit("message", { data: frameBuffer(9, [1]) });
    expect(sockets[0]?.sent).toEqual([]);

    hidden = false;
    sockets[0]?.emit("message", { data: frameBuffer(10, [1]) });
    expect(sockets[0]?.sent).toEqual([ackMessage(10)]);
  });

  test("text messages reach their handlers", () => {
    const { calls, sockets, start } = harness();
    start();
    sockets[0]?.open();

    sockets[0]?.emit("message", {
      data: '{"t":"problem","code":"human_in_control","message":""}',
    });
    sockets[0]?.emit("message", {
      data: '{"t":"error","code":"lease_required","message":""}',
    });
    sockets[0]?.emit("message", {
      data: JSON.stringify({ ...status, t: "status" }),
    });

    expect(calls).toEqual([
      "open",
      "problem:human_in_control",
      "input_error:lease_required",
      "status",
    ]);
  });

  test("input is sent while open and refused while not", () => {
    const { sockets, start } = harness();
    const stream = start();
    const action = { keys: "Return", type: "key" } as const;
    expect(stream.sendInput([action])).toBe(false);

    sockets[0]?.open();

    expect(stream.sendInput([action])).toBe(true);
    expect(sockets[0]?.sent).toEqual([inputMessage([action])]);
  });

  test("a dropped socket is reopened after a backoff that grows and then caps", () => {
    const { sockets, start, runNextTimer, timers } = harness();
    start();
    sockets[0]?.open();

    const delays: number[] = [];
    for (let drop = 0; drop < 6; drop += 1) {
      sockets.at(-1)?.shut();
      delays.push(timers.at(-1)?.delay ?? -1);
      runNextTimer();
    }

    expect(delays).toEqual([500, 1000, 2000, 4000, 4000, 4000]);
    expect(sockets).toHaveLength(7);
  });

  test("a socket that never opens is retried forever", () => {
    const { calls, sockets, start, runNextTimer } = harness();
    start();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      sockets.at(-1)?.shut();
      runNextTimer();
    }

    expect(sockets).toHaveLength(11);
    expect(calls.filter((call) => call === "closed:false")).toHaveLength(10);
  });

  test("an open resets the backoff", () => {
    const { sockets, start, runNextTimer, timers } = harness();
    start();
    sockets[0]?.shut();
    runNextTimer();
    sockets[1]?.shut();
    runNextTimer();
    sockets[2]?.open();
    sockets[2]?.shut();

    expect(timers.at(-1)?.delay).toBe(500);
  });

  test("onClosed reports whether the closed socket had opened", () => {
    const { calls, sockets, start, runNextTimer } = harness();
    start();
    sockets[0]?.shut();
    runNextTimer();
    sockets[1]?.open();
    sockets[1]?.shut();

    expect(calls).toEqual(["closed:false", "open", "closed:true"]);
  });

  test("closing the stream closes the socket and stops reconnecting", () => {
    const { calls, sockets, start, timers } = harness();
    const stream = start();
    sockets[0]?.open();

    stream.close();
    sockets[0]?.shut();

    expect(sockets[0]?.closedWith).toBe(CLOSE_NORMAL);
    expect(calls).toEqual(["open"]);
    expect(timers.every((timer) => timer.cancelled)).toBe(true);
    expect(stream.isOpen()).toBe(false);
  });

  test("closing during a pending reconnect cancels it", () => {
    const { sockets, start, timers } = harness();
    const stream = start();
    sockets[0]?.shut();
    expect(timers).toHaveLength(1);

    stream.close();

    expect(timers[0]?.cancelled).toBe(true);
    expect(sockets).toHaveLength(1);
  });
});
