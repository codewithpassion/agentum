import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ackMessage,
  type DesktopStreamHandlers,
  inputMessage,
  MAX_OPEN_FAILURES,
  openDesktopStream,
  parseFrame,
  parseStreamMessage,
  problemFromCode,
  streamUrl,
} from "./desktop-stream";

const realSetTimeout = globalThis.setTimeout;

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
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }
  send(data: string) {
    this.sent.push(data);
  }
  shut() {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

let sockets: FakeSocket[] = [];
let calls: string[] = [];
let timers: (() => void)[] = [];

beforeEach(() => {
  sockets = [];
  calls = [];
  timers = [];
  Object.assign(globalThis, {
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
  });
});

afterEach(() => {
  Object.assign(globalThis, { setTimeout: realSetTimeout });
});

const frameBuffer = (id: number, bytes: number[]): ArrayBuffer => {
  const buffer = new Uint8Array(4 + bytes.length);
  new DataView(buffer.buffer).setUint32(0, id);
  buffer.set(bytes, 4);
  return buffer.buffer;
};

const handlers = (): DesktopStreamHandlers => ({
  onFrame: () => calls.push("frame"),
  onInputError: (code) => calls.push(`input_error:${code}`),
  onInterrupted: () => calls.push("interrupted"),
  onOpen: () => calls.push("open"),
  onProblem: (problem) => calls.push(`problem:${problem.kind}`),
  onStatus: () => calls.push("status"),
  onUnavailable: () => calls.push("unavailable"),
});

const start = (hidden = false) =>
  openDesktopStream({
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    handlers: handlers(),
    isHidden: () => hidden,
    url: "wss://app.example/api/w/acme/agents/a1/desktop/stream",
  });

describe("message parsing", () => {
  test("a status message keeps the status fields", () => {
    const message = parseStreamMessage(
      JSON.stringify({
        connected: true,
        control: null,
        desktop: true,
        desktopUnavailableReason: null,
        t: "status",
        youHaveControl: false,
      })
    );

    expect(message).toMatchObject({
      status: { connected: true, youHaveControl: false },
      t: "status",
    });
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

  test("outgoing messages have the shape the relay reads", () => {
    expect(JSON.parse(ackMessage(7))).toEqual({ id: 7, t: "ack" });
    expect(JSON.parse(inputMessage([{ keys: "Return", type: "key" }]))).toEqual(
      { actions: [{ keys: "Return", type: "key" }], t: "input" }
    );
  });

  test("problem codes become the view's frame problems", () => {
    expect(problemFromCode("human_in_control", "")).toEqual({
      kind: "human_in_control",
    });
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
});

describe("the stream connection", () => {
  test("frames are handed over and acked", () => {
    const stream = start();
    sockets[0]?.open();

    sockets[0]?.emit("message", { data: frameBuffer(5, [1, 2]) });

    expect(calls).toEqual(["open", "frame"]);
    expect(sockets[0]?.sent).toEqual([ackMessage(5)]);
    expect(stream.isOpen()).toBe(true);
  });

  test("a hidden tab does not ack until it is visible again", () => {
    let hidden = true;
    const socket = new FakeSocket();
    openDesktopStream({
      createSocket: () => socket as unknown as WebSocket,
      handlers: handlers(),
      isHidden: () => hidden,
      url: "wss://x/y",
    });
    socket.open();

    socket.emit("message", { data: frameBuffer(9, [1]) });
    expect(socket.sent).toEqual([]);

    hidden = false;
    socket.emit("message", { data: frameBuffer(10, [1]) });
    expect(socket.sent).toEqual([ackMessage(10)]);
  });

  test("text messages reach their handlers", () => {
    start();
    sockets[0]?.open();

    sockets[0]?.emit("message", {
      data: '{"t":"problem","code":"human_in_control","message":""}',
    });
    sockets[0]?.emit("message", {
      data: '{"t":"error","code":"lease_required","message":""}',
    });
    sockets[0]?.emit("message", {
      data: '{"t":"status","connected":true,"control":null,"desktop":true,"desktopUnavailableReason":null,"youHaveControl":false}',
    });

    expect(calls).toEqual([
      "open",
      "problem:human_in_control",
      "input_error:lease_required",
      "status",
    ]);
  });

  test("input is sent while open and refused while not", () => {
    const stream = start();
    const action = { keys: "Return", type: "key" } as const;
    expect(stream.sendInput([action])).toBe(false);

    sockets[0]?.open();

    expect(stream.sendInput([action])).toBe(true);
    expect(sockets[0]?.sent).toEqual([inputMessage([action])]);
  });

  test("a dropped socket is reopened after a backoff", () => {
    start();
    sockets[0]?.open();

    sockets[0]?.shut();
    expect(calls).toEqual(["open", "interrupted"]);
    timers.pop()?.();

    expect(sockets).toHaveLength(2);
  });

  test("a socket that never opens falls back to polling after repeated failures", () => {
    start();
    for (let attempt = 0; attempt < MAX_OPEN_FAILURES; attempt += 1) {
      sockets[attempt]?.shut();
      timers.pop()?.();
    }

    expect(calls).toEqual(["unavailable"]);
    expect(sockets).toHaveLength(MAX_OPEN_FAILURES);
  });

  test("an open resets the failure count", () => {
    start();
    sockets[0]?.shut();
    timers.pop()?.();
    sockets[1]?.open();
    sockets[1]?.shut();
    timers.pop()?.();
    sockets[2]?.shut();

    expect(calls).not.toContain("unavailable");
  });

  test("closing the stream closes the socket and stops reconnecting", () => {
    const stream = start();
    sockets[0]?.open();

    stream.close();
    sockets[0]?.shut();

    expect(sockets[0]?.closedWith).toBe(1000);
    expect(timers).toHaveLength(0);
    expect(stream.isOpen()).toBe(false);
  });
});
