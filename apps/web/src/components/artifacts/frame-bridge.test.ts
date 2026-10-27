import { expect, test } from "bun:test";
import type { UiInitializeResult } from "@repo/protocol/artifacts";
import {
  BRIDGE_ERROR,
  BridgeError,
  type BridgePort,
  type BridgeTarget,
  createFrameBridge,
  type FrameBridgeOptions,
} from "./frame-bridge.ts";

const INIT: UiInitializeResult = {
  theme: "light",
  version: { createdAt: "2026-10-27T00:00:00.000Z", number: 2 },
  viewer: "member",
};

interface Posted {
  message: unknown;
  origin: string;
  transfer: Transferable[];
}

const NONCE = "nonce-1";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(overrides: Partial<FrameBridgeOptions> = {}) {
  const posted: Posted[] = [];
  const target: BridgeTarget = {
    postMessage: (message, origin, transfer) => {
      posted.push({ message, origin, transfer });
    },
  };
  const ports: { port1: BridgePort; sent: unknown[] }[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const opened: string[] = [];
  const confirmed: string[] = [];
  let blanked = 0;
  const sizes: unknown[] = [];
  const bridge = createFrameBridge({
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    confirmOpenLink: (url) => {
      confirmed.push(url);
      return true;
    },
    createChannel: () => {
      const sent: unknown[] = [];
      const port1: BridgePort = {
        close: () => undefined,
        onmessage: null,
        postMessage: (message) => {
          sent.push(message);
        },
      };
      ports.push({ port1, sent });
      return { port1, port2: { fake: "port2" } };
    },
    getInit: () => INIT,
    getTarget: () => target,
    nonce: NONCE,
    onBlank: () => {
      blanked += 1;
    },
    onSizeChanged: (size) => {
      sizes.push(size);
    },
    openLink: (url) => {
      opened.push(url);
    },
    setTimer: (fn, ms) => {
      const timer = { cleared: false, fn, ms };
      timers.push(timer);
      return timer;
    },
    ...overrides,
  });
  // `nonce: null` sends an initialize with no nonce at all.
  const initialize = (
    source: unknown = target,
    id: string | number = 1,
    nonce: string | null = NONCE
  ) =>
    bridge.handleWindowMessage({
      data: {
        id,
        jsonrpc: "2.0",
        method: "ui/initialize",
        params: {
          protocolVersion: "2026-01-26",
          ...(nonce === null ? {} : { nonce }),
        },
      },
      source,
    });
  const toPort = (data: unknown) => {
    ports.at(-1)?.port1.onmessage?.({ data } as MessageEvent);
  };
  const fireTimers = () => {
    for (const timer of timers) {
      if (!timer.cleared) {
        timer.cleared = true;
        timer.fn();
      }
    }
  };
  return {
    blanked: () => blanked,
    bridge,
    confirmed,
    fireTimers,
    initialize,
    opened,
    ports,
    posted,
    sizes,
    target,
    timers,
    toPort,
  };
}

test("ui/initialize from the iframe window transfers one port and answers with theme, viewer and version", () => {
  const t = setup();
  t.initialize(t.target, 7);
  expect(t.posted).toHaveLength(1);
  const [reply] = t.posted;
  expect(reply?.origin).toBe("*");
  expect(reply?.message).toEqual({ id: 7, jsonrpc: "2.0", result: INIT });
  expect(reply?.transfer).toEqual([
    { fake: "port2" } as unknown as Transferable,
  ]);
});

test("a message from any other window is ignored", () => {
  const t = setup();
  t.initialize({ other: true });
  t.initialize(null);
  expect(t.posted).toHaveLength(0);
  expect(t.ports).toHaveLength(0);
});

test("window messages other than a valid ui/initialize request get no port", () => {
  const t = setup();
  const send = (data: unknown) =>
    t.bridge.handleWindowMessage({ data, source: t.target });
  send({
    id: 1,
    jsonrpc: "2.0",
    method: "ui/open-link",
    params: { url: "https://a.test" },
  });
  send({
    id: 1,
    jsonrpc: "2.0",
    method: "ui/initialize",
    params: { extra: 1 },
  });
  send("hello");
  send({
    jsonrpc: "2.0",
    method: "ui/initialize",
    params: { protocolVersion: "x" },
  });
  expect(t.posted).toHaveLength(0);
  expect(t.ports).toHaveLength(0);
});

test("a malformed message over the port gets an invalid-request error when it has an id", async () => {
  const t = setup();
  t.initialize();
  t.toPort({
    id: 4,
    jsonrpc: "2.0",
    method: "ui/open-link",
    params: { url: "javascript:alert(1)" },
  });
  t.toPort({ jsonrpc: "2.0", method: "nope" });
  await flush();
  expect(t.ports[0]?.sent).toEqual([
    {
      error: { code: BRIDGE_ERROR.invalidRequest, message: "Invalid request" },
      id: 4,
      jsonrpc: "2.0",
    },
  ]);
  expect(t.opened).toHaveLength(0);
  expect(t.confirmed).toHaveLength(0);
});

test("ui/open-link opens a new tab only after the viewer confirms", async () => {
  let answer = false;
  const t = setup({
    confirmOpenLink: () => answer,
  });
  t.initialize();
  const request = (id: number) => ({
    id,
    jsonrpc: "2.0",
    method: "ui/open-link",
    params: { url: "https://example.com/x" },
  });
  t.toPort(request(1));
  await flush();
  expect(t.opened).toHaveLength(0);
  expect(t.ports[0]?.sent[0]).toMatchObject({
    error: { code: BRIDGE_ERROR.denied },
    id: 1,
  });
  answer = true;
  t.toPort(request(2));
  await flush();
  expect(t.opened).toEqual(["https://example.com/x"]);
  expect(t.ports[0]?.sent[1]).toEqual({ id: 2, jsonrpc: "2.0", result: {} });
});

test("a second link request while one is waiting for the viewer is refused", async () => {
  let release: (value: boolean) => void = () => undefined;
  const t = setup({
    confirmOpenLink: () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  });
  t.initialize();
  const request = (id: number) => ({
    id,
    jsonrpc: "2.0",
    method: "ui/open-link",
    params: { url: "https://example.com" },
  });
  t.toPort(request(1));
  t.toPort(request(2));
  await flush();
  expect(t.ports[0]?.sent[0]).toMatchObject({
    error: { code: BRIDGE_ERROR.denied },
    id: 2,
  });
  release(true);
  await flush();
  expect(t.opened).toEqual(["https://example.com"]);
});

test("size changes reach the callback and need no reply", async () => {
  const t = setup();
  t.initialize();
  t.toPort({
    jsonrpc: "2.0",
    method: "ui/notifications/size-changed",
    params: { height: 480 },
  });
  await flush();
  expect(t.sizes).toEqual([{ height: 480 }]);
  expect(t.ports[0]?.sent).toHaveLength(0);
});

test("methods without a handler answer method-not-found, and extra handlers plug in", async () => {
  const t = setup({
    extraHandlers: {
      "storage/get": () => ({ value: 5 }),
    },
  });
  t.initialize();
  t.toPort({
    id: 1,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: "x" },
  });
  t.toPort({
    id: 2,
    jsonrpc: "2.0",
    method: "storage/get",
    params: { key: "k", scope: "viewer" },
  });
  await flush();
  expect(t.ports[0]?.sent).toEqual([
    {
      error: {
        code: BRIDGE_ERROR.methodNotFound,
        message: "Method not found: tools/call",
      },
      id: 1,
      jsonrpc: "2.0",
    },
    { id: 2, jsonrpc: "2.0", result: { value: 5 } },
  ]);
});

test("a second ui/initialize over the live port is refused", async () => {
  const t = setup();
  t.initialize();
  t.toPort({
    id: 9,
    jsonrpc: "2.0",
    method: "ui/initialize",
    params: { protocolVersion: "x" },
  });
  await flush();
  expect(t.ports[0]?.sent[0]).toMatchObject({
    error: { code: BRIDGE_ERROR.invalidRequest },
    id: 9,
  });
});

test("load after an initialize is fine and sets no timer", () => {
  const t = setup();
  t.initialize();
  t.bridge.handleLoad();
  expect(t.timers).toHaveLength(0);
  expect(t.blanked()).toBe(0);
});

test("a load with no initialize blanks the frame once the grace period ends", () => {
  const t = setup();
  t.initialize();
  t.bridge.handleLoad();
  // The iframe navigates away: a new document loads and never initializes.
  t.bridge.handleLoad();
  expect(t.blanked()).toBe(0);
  expect(t.timers).toHaveLength(1);
  t.fireTimers();
  expect(t.blanked()).toBe(1);
  // The old port is dead, and the blanked frame ignores the window.
  t.initialize();
  expect(t.posted).toHaveLength(1);
});

test("an initialize that lands just after load cancels the blanking", () => {
  const t = setup();
  t.bridge.handleLoad();
  expect(t.timers).toHaveLength(1);
  t.initialize();
  t.fireTimers();
  expect(t.blanked()).toBe(0);
});

test("repeat initializes from the page's retry loop are ignored", () => {
  const t = setup();
  t.initialize();
  // In flight before the page saw the reply, before and after its load event.
  t.initialize();
  t.bridge.handleLoad();
  t.initialize();
  expect(t.posted).toHaveLength(1);
  expect(t.ports).toHaveLength(1);
});

test("the nonce works once: a replay after the iframe navigated gets no port and the frame blanks", () => {
  const t = setup();
  t.initialize(t.target, 1);
  t.bridge.handleLoad();
  // A page the artifact navigated to, holding the nonce it read from the URL.
  t.bridge.handleLoad();
  t.initialize(t.target, 2, NONCE);
  t.initialize(t.target, 3, "wrong");
  expect(t.ports).toHaveLength(1);
  expect(t.posted).toHaveLength(1);
  t.fireTimers();
  expect(t.blanked()).toBe(1);
});

test("a late repeat of the accepted initialize is ignored", () => {
  const t = setup();
  t.initialize();
  t.initialize();
  expect(t.posted).toHaveLength(1);
  expect(t.ports).toHaveLength(1);
});

test("dispose stops everything", () => {
  const t = setup();
  t.bridge.dispose();
  t.initialize();
  t.bridge.handleLoad();
  expect(t.posted).toHaveLength(0);
  expect(t.timers).toHaveLength(0);
});

test("an initialize with the right nonce gets a port", () => {
  const t = setup();
  t.initialize(t.target, 3, NONCE);
  expect(t.ports).toHaveLength(1);
  expect(t.posted).toHaveLength(1);
});

test("an initialize with a wrong nonce gets no reply and no port", () => {
  const t = setup();
  t.initialize(t.target, 3, "not-the-nonce");
  expect(t.posted).toHaveLength(0);
  expect(t.ports).toHaveLength(0);
});

test("an initialize with no nonce gets no reply and no port", () => {
  const t = setup();
  t.initialize(t.target, 3, null);
  expect(t.posted).toHaveLength(0);
  expect(t.ports).toHaveLength(0);
});

test("a load followed only by wrong-nonce initializes blanks the frame after the grace period", () => {
  const t = setup();
  t.bridge.handleLoad();
  t.initialize(t.target, 1, "wrong");
  t.initialize(t.target, 2, null);
  expect(t.timers).toHaveLength(1);
  t.fireTimers();
  expect(t.blanked()).toBe(1);
  expect(t.posted).toHaveLength(0);
});

test("an extra handler's plain Error is answered with a fixed message", async () => {
  const t = setup({
    extraHandlers: {
      "storage/get": () => {
        throw new Error("secret detail");
      },
    },
  });
  t.initialize();
  t.toPort({
    id: 1,
    jsonrpc: "2.0",
    method: "storage/get",
    params: { key: "k", scope: "viewer" },
  });
  await flush();
  expect(t.ports[0]?.sent).toEqual([
    {
      error: { code: BRIDGE_ERROR.denied, message: "Request failed" },
      id: 1,
      jsonrpc: "2.0",
    },
  ]);
});

test("an extra handler's BridgeError is answered with its own code and message", async () => {
  const t = setup({
    extraHandlers: {
      "storage/get": () => {
        throw new BridgeError(BRIDGE_ERROR.failed, "Nope");
      },
    },
  });
  t.initialize();
  t.toPort({
    id: 1,
    jsonrpc: "2.0",
    method: "storage/get",
    params: { key: "k", scope: "viewer" },
  });
  await flush();
  expect(t.ports[0]?.sent).toEqual([
    {
      error: { code: BRIDGE_ERROR.failed, message: "Nope" },
      id: 1,
      jsonrpc: "2.0",
    },
  ]);
});
