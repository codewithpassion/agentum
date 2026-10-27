import { afterEach, describe, expect, test } from "bun:test";
import {
  storageDeleteRequestSchema,
  storageGetRequestSchema,
  storageListRequestSchema,
  storageSetRequestSchema,
  toolsCallRequestSchema,
  uiInitializedNotificationSchema,
  uiInitializeRequestSchema,
  uiMessageRequestSchema,
  uiOpenLinkRequestSchema,
  uiSizeChangedNotificationSchema,
} from "@repo/protocol/artifacts";
import { BRIDGE_JS } from "./bridge.ts";

type Listener = (event: unknown) => void;

interface Posted {
  message: unknown;
  targetOrigin: unknown;
}

interface Timer {
  callback: () => void;
  id: number;
}

type Scope = "viewer" | "shared";

interface HarbourmasterApi {
  openLink: (url: string) => Promise<unknown>;
  ready: Promise<unknown>;
  request: (method: string, params?: unknown) => Promise<unknown>;
  sendMessage: (text: string) => Promise<unknown>;
  storage: {
    delete: (key: string, scope?: Scope) => Promise<unknown>;
    get: (key: string, scope?: Scope) => Promise<unknown>;
    list: (prefix?: string, scope?: Scope) => Promise<unknown>;
    set: (key: string, value: unknown, scope?: Scope) => Promise<unknown>;
  };
  readonly theme: string | null;
  tools: {
    call: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  readonly version: unknown;
  readonly viewer: string | null;
}

interface FakeWindow {
  addEventListener: (type: string, listener: Listener) => void;
  parent: unknown;
  [key: string]: unknown;
}

interface FakeClickEvent {
  defaultPrevented: boolean;
  preventDefault: () => void;
  target: unknown;
}

const INIT_RESULT = {
  theme: "dark",
  version: { createdAt: "2026-10-27T00:00:00.000Z", number: 3 },
  viewer: "member",
};

const SCRIPT_SRC = "http://x.test/a/ID/c/TOKEN/_hm/bridge.js";
const FOLDER = "http://x.test/a/ID/c/TOKEN/";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const channels: MessageChannel[] = [];

afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});

/** Collects what arrives on the frame end of the channel. */
class Inbox {
  readonly messages: unknown[] = [];
  private waiter: (() => void) | null = null;

  constructor(port: MessagePort) {
    port.onmessage = (event: MessageEvent) => {
      this.messages.push(event.data);
      this.waiter?.();
    };
  }

  async take(count: number): Promise<unknown[]> {
    if (this.messages.length >= count) {
      return this.messages.slice(0, count);
    }
    await new Promise<void>((resolve) => {
      this.waiter = resolve;
    });
    return this.take(count);
  }
}

const makeEnv = (
  options: { framed?: boolean; name?: string; withObserver?: boolean } = {}
) => {
  const { framed = true, name, withObserver = false } = options;
  const posted: Posted[] = [];
  const listeners = new Map<string, Listener[]>();
  const documentListeners = new Map<string, Listener[]>();
  const timers: Timer[] = [];
  const cleared: number[] = [];
  let nextTimerId = 1;
  const observers: { callback: () => void; observed: unknown[] }[] = [];

  const parent = {
    postMessage: (message: unknown, targetOrigin: unknown) => {
      posted.push({ message, targetOrigin });
    },
  };
  const win: FakeWindow = {
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    parent,
    requestAnimationFrame: (callback: () => void) => {
      callback();
      return 1;
    },
  };
  if (!framed) {
    win.parent = win;
  }
  if (name !== undefined) {
    win.name = name;
  }
  let rect = { height: 100.2, width: 640.7 };
  if (withObserver) {
    win.ResizeObserver = class {
      constructor(callback: () => void) {
        observers.push({ callback, observed: [] });
      }
      observe(target: unknown) {
        observers.at(-1)?.observed.push(target);
      }
    };
  }
  const documentElement = { getBoundingClientRect: () => rect };
  const doc = {
    addEventListener: (type: string, listener: Listener) => {
      documentListeners.set(type, [
        ...(documentListeners.get(type) ?? []),
        listener,
      ]);
    },
    currentScript: { src: SCRIPT_SRC },
    documentElement,
  };
  const setTimeoutStub = (callback: () => void) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.push({ callback, id });
    return id;
  };
  const clearTimeoutStub = (id: number) => {
    cleared.push(id);
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) {
      timers.splice(index, 1);
    }
  };

  new Function("window", "document", "setTimeout", "clearTimeout", BRIDGE_JS)(
    win,
    doc,
    setTimeoutStub,
    clearTimeoutStub
  );

  const harbourmaster = win.harbourmaster as HarbourmasterApi;

  return {
    click: (target: unknown): FakeClickEvent => {
      const event: FakeClickEvent = {
        defaultPrevented: false,
        preventDefault: () => {
          event.defaultPrevented = true;
        },
        target,
      };
      for (const listener of documentListeners.get("click") ?? []) {
        listener(event);
      }
      return event;
    },
    deliver: (event: unknown) => {
      for (const listener of listeners.get("message") ?? []) {
        listener(event);
      }
    },
    harbourmaster,
    observers,
    parent,
    posted,
    setRect: (next: { height: number; width: number }) => {
      rect = next;
    },
    /** Fires the pending retry timer, as if 250 ms passed. */
    tick: () => {
      const timer = timers.shift();
      timer?.callback();
    },
    timers,
    win,
  };
};

type Env = ReturnType<typeof makeEnv>;

const initResponse = (result: unknown = INIT_RESULT) => ({
  id: 1,
  jsonrpc: "2.0",
  result,
});

/** Connects the page and returns the frame end of the port. */
const connect = (env: Env): Inbox => {
  const channel = new MessageChannel();
  channels.push(channel);
  const inbox = new Inbox(channel.port1);
  env.deliver({
    data: initResponse(),
    ports: [channel.port2],
    source: env.parent,
  });
  return inbox;
};

const link = (href: string, tagName = "A") => ({
  href,
  parentNode: null,
  tagName,
});

describe("bridge handshake", () => {
  test("posts a valid ui/initialize to the parent with target origin * and retries", () => {
    const env = makeEnv();
    expect(env.posted).toHaveLength(1);
    const [first] = env.posted;
    expect(first?.targetOrigin).toBe("*");
    const parsed = uiInitializeRequestSchema.parse(first?.message);
    expect(parsed.id).toBe(1);
    expect(parsed.params.protocolVersion).toBe("2026-01-26");
    expect(parsed.params.appInfo).toEqual({
      name: "harbourmaster-bridge",
      version: "1",
    });

    env.tick();
    env.tick();
    expect(env.posted).toHaveLength(3);
    expect(env.posted[2]?.message).toEqual(first?.message);
  });

  test("stops retrying after 40 tries and ready resolves null", async () => {
    const env = makeEnv();
    for (let i = 0; i < 60; i += 1) {
      env.tick();
    }
    expect(env.posted).toHaveLength(40);
    expect(env.timers).toHaveLength(0);
    expect(await env.harbourmaster.ready).toBeNull();
    expect(env.harbourmaster.theme).toBeNull();
  });

  test("a response with a port stops retries and starts initialized and size-changed", async () => {
    const env = makeEnv();
    const inbox = connect(env);
    expect(env.timers).toHaveLength(0);
    expect(env.posted).toHaveLength(1);

    const [initialized, size] = await inbox.take(2);
    uiInitializedNotificationSchema.parse(initialized);
    const parsedSize = uiSizeChangedNotificationSchema.parse(size);
    expect(parsedSize.params).toEqual({ height: 101, width: 641 });
  });

  test("ready resolves to the result and the getters read it", async () => {
    const env = makeEnv();
    expect(env.harbourmaster.theme).toBeNull();
    expect(env.harbourmaster.viewer).toBeNull();
    expect(env.harbourmaster.version).toBeNull();
    connect(env);
    expect(await env.harbourmaster.ready).toEqual(INIT_RESULT);
    expect(env.harbourmaster.theme).toBe("dark");
    expect(env.harbourmaster.viewer).toBe("member");
    expect(env.harbourmaster.version).toEqual(INIT_RESULT.version);
    expect(Object.isFrozen(env.harbourmaster)).toBe(true);
  });

  test("ignores a response from the wrong source", async () => {
    const env = makeEnv();
    const channel = new MessageChannel();
    channels.push(channel);
    const inbox = new Inbox(channel.port1);
    env.deliver({
      data: initResponse(),
      ports: [channel.port2],
      source: {},
    });
    expect(env.timers).toHaveLength(1);
    await expect(env.harbourmaster.request("x")).rejects.toThrow(
      "not connected"
    );
    await sleep(10);
    expect(inbox.messages).toHaveLength(0);
  });

  test("ignores a response without a port, and one with a bad shape", () => {
    const env = makeEnv();
    env.deliver({ data: initResponse(), ports: [], source: env.parent });
    env.deliver({ data: initResponse(), source: env.parent });
    const channel = new MessageChannel();
    channels.push(channel);
    env.deliver({
      data: initResponse({ theme: "dark" }),
      ports: [channel.port2],
      source: env.parent,
    });
    env.deliver({
      data: { ...initResponse(), id: 2 },
      ports: [channel.port2],
      source: env.parent,
    });
    expect(env.timers).toHaveLength(1);
    expect(env.harbourmaster.theme).toBeNull();
  });

  test("ignores a second initialize response", async () => {
    const env = makeEnv();
    const first = connect(env);
    await first.take(2);

    const channel = new MessageChannel();
    channels.push(channel);
    const second = new Inbox(channel.port1);
    env.deliver({
      data: initResponse({ ...INIT_RESULT, theme: "light" }),
      ports: [channel.port2],
      source: env.parent,
    });
    await sleep(10);
    expect(second.messages).toHaveLength(0);
    expect(env.harbourmaster.theme).toBe("dark");
  });

  test("opened directly: no message is posted and ready resolves null", async () => {
    const env = makeEnv({ framed: false });
    expect(env.posted).toHaveLength(0);
    expect(env.timers).toHaveLength(0);
    expect(await env.harbourmaster.ready).toBeNull();
    await expect(env.harbourmaster.openLink("https://a.test/")).rejects.toThrow(
      "not connected"
    );
  });
});

describe("bridge size", () => {
  test("sends size-changed when the ResizeObserver fires", async () => {
    const env = makeEnv({ withObserver: true });
    const inbox = connect(env);
    await inbox.take(2);
    expect(env.observers).toHaveLength(1);

    env.setRect({ height: 300, width: 500 });
    env.observers[0]?.callback();
    const messages = await inbox.take(3);
    expect(uiSizeChangedNotificationSchema.parse(messages[2]).params).toEqual({
      height: 300,
      width: 500,
    });
  });
});

describe("bridge requests", () => {
  test("openLink sends ui/open-link and resolves on the matching result", async () => {
    const env = makeEnv();
    const inbox = connect(env);
    await inbox.take(2);

    const result = env.harbourmaster.openLink("https://example.com/path");
    const [, , sent] = await inbox.take(3);
    const parsed = uiOpenLinkRequestSchema.parse(sent);
    expect(parsed.params.url).toBe("https://example.com/path");
    expect(parsed.id).toBe(2);

    const channel = channels.at(0);
    channel?.port1.postMessage({ id: parsed.id, jsonrpc: "2.0", result: {} });
    expect(await result).toEqual({});
  });

  test("openLink rejects a non-http url", async () => {
    const env = makeEnv();
    connect(env);
    await expect(
      env.harbourmaster.openLink("javascript:alert(1)")
    ).rejects.toThrow("http or https");
    await expect(env.harbourmaster.openLink("not a url")).rejects.toThrow(
      "http or https"
    );
  });

  test("request uses incrementing ids and rejects on a JSON-RPC error", async () => {
    const env = makeEnv();
    const inbox = connect(env);
    await inbox.take(2);

    const first = env.harbourmaster.request("custom/one", { a: 1 });
    const second = env.harbourmaster.request("custom/two");
    const messages = await inbox.take(4);
    expect(messages[2]).toEqual({
      id: 2,
      jsonrpc: "2.0",
      method: "custom/one",
      params: { a: 1 },
    });
    expect(messages[3]).toEqual({
      id: 3,
      jsonrpc: "2.0",
      method: "custom/two",
    });

    const port = channels.at(0)?.port1;
    port?.postMessage({
      error: { code: -32_601, message: "Method not found" },
      id: 2,
      jsonrpc: "2.0",
    });
    port?.postMessage({ id: 3, jsonrpc: "2.0", result: { ok: true } });
    await expect(first).rejects.toThrow("Method not found");
    expect(await second).toEqual({ ok: true });
  });
});

describe("bridge link interception", () => {
  test("an external http link is sent to the viewer", async () => {
    const env = makeEnv();
    const inbox = connect(env);
    await inbox.take(2);

    const event = env.click(link("https://example.com/out"));
    expect(event.defaultPrevented).toBe(true);
    const [, , sent] = await inbox.take(3);
    expect(uiOpenLinkRequestSchema.parse(sent).params.url).toBe(
      "https://example.com/out"
    );
  });

  test("a click inside an anchor is intercepted through its parent chain", async () => {
    const env = makeEnv();
    const inbox = connect(env);
    await inbox.take(2);

    const anchor = link("http://other.test/x");
    const event = env.click({ parentNode: anchor, tagName: "SPAN" });
    expect(event.defaultPrevented).toBe(true);
    await inbox.take(3);
  });

  test("a link inside the content folder is left alone", async () => {
    const env = makeEnv();
    const inbox = connect(env);
    await inbox.take(2);

    const event = env.click(link(`${FOLDER}page2.html#top`));
    expect(event.defaultPrevented).toBe(false);
    await sleep(10);
    expect(inbox.messages).toHaveLength(2);
  });

  test("non-http links and clicks off any link are left alone", async () => {
    const env = makeEnv();
    const inbox = connect(env);
    await inbox.take(2);

    expect(env.click(link("mailto:a@b.test")).defaultPrevented).toBe(false);
    expect(
      env.click({ parentNode: null, tagName: "DIV" }).defaultPrevented
    ).toBe(false);
    await sleep(10);
    expect(inbox.messages).toHaveLength(2);
  });

  test("links keep working while the bridge is not connected", () => {
    const env = makeEnv();
    expect(env.click(link("https://example.com/out")).defaultPrevented).toBe(
      false
    );
  });
});

describe("bridge storage stand-ins", () => {
  const storages = ["localStorage", "sessionStorage"] as const;

  for (const name of storages) {
    test(`${name} implements the Storage interface`, () => {
      const env = makeEnv();
      const storage = env.win[name] as Storage;

      expect(storage.length).toBe(0);
      expect(storage.getItem("a")).toBeNull();

      storage.setItem("a", "1");
      storage.setItem("n", 42 as unknown as string);
      expect(storage.getItem("a")).toBe("1");
      expect(storage.getItem("n")).toBe("42");
      expect(storage.length).toBe(2);
      expect(storage.key(0)).toBe("a");
      expect(storage.key(1)).toBe("n");
      expect(storage.key(2)).toBeNull();

      storage.removeItem("a");
      expect(storage.getItem("a")).toBeNull();
      expect(storage.length).toBe(1);

      storage.clear();
      expect(storage.length).toBe(0);
      expect(storage.key(0)).toBeNull();
    });

    test(`${name} supports property access, in, delete and Object.keys`, () => {
      const env = makeEnv();
      const storage = env.win[name] as Record<string, unknown>;

      storage.foo = "x";
      storage.num = 7;
      expect(storage.foo).toBe("x");
      expect(storage.num).toBe("7");
      expect("foo" in storage).toBe(true);
      expect("missing" in storage).toBe(false);
      expect(storage.missing).toBeUndefined();
      expect(Object.keys(storage)).toEqual(["foo", "num"]);
      expect((storage as unknown as Storage).getItem("foo")).toBe("x");
      expect((storage as unknown as Storage).length).toBe(2);

      Reflect.deleteProperty(storage, "foo");
      expect("foo" in storage).toBe(false);
      expect(Object.keys(storage)).toEqual(["num"]);
    });
  }

  test("localStorage and sessionStorage are separate and stable", () => {
    const env = makeEnv();
    (env.win.localStorage as Storage).setItem("k", "local");
    expect((env.win.sessionStorage as Storage).getItem("k")).toBeNull();
    expect(env.win.localStorage).toBe(env.win.localStorage);
  });
});

describe("bridge nonce", () => {
  const initParams = (env: Env) =>
    uiInitializeRequestSchema.parse(env.posted[0]?.message).params;

  test("window.name is sent as the nonce in ui/initialize", () => {
    const env = makeEnv({ name: "abc123" });
    expect(
      uiInitializeRequestSchema.parse(env.posted[0]?.message).params
    ).toEqual({
      appInfo: { name: "harbourmaster-bridge", version: "1" },
      nonce: "abc123",
      protocolVersion: "2026-01-26",
    });
  });

  test("no name, or an empty one, sends no nonce key", () => {
    for (const name of [undefined, ""]) {
      expect("nonce" in initParams(makeEnv({ name }))).toBe(false);
    }
  });

  test("links to other pages of the artifact are left to the browser, the name travels with the tab", async () => {
    const env = makeEnv({ name: "abc123" });
    const inbox = connect(env);
    await inbox.take(2);
    expect(env.click(link(`${FOLDER}page2.html#top`)).defaultPrevented).toBe(
      false
    );
  });
});

describe("bridge phase 2 API", () => {
  const respond = (id: number, result: unknown) => {
    channels.at(0)?.port1.postMessage({ id, jsonrpc: "2.0", result });
  };

  /** Starts one call on a connected page, answers it, and returns what the frame saw. */
  const roundTrip = async (
    inbox: Inbox,
    start: () => Promise<unknown>,
    reply: unknown
  ) => {
    const pending = start();
    const [, , sent] = await inbox.take(3);
    respond((sent as { id: number }).id, reply);
    return { result: await pending, sent };
  };

  test("tools.call sends tools/call and resolves to the frame result", async () => {
    const env = makeEnv();
    const inbox = connect(env);
    await inbox.take(2);

    const reply = {
      content: [{ text: "hi", type: "text" }],
      structuredContent: { n: 1 },
    };
    const { result, sent } = await roundTrip(
      inbox,
      () => env.harbourmaster.tools.call("search", { q: "x" }),
      reply
    );
    expect(toolsCallRequestSchema.parse(sent).params).toEqual({
      arguments: { q: "x" },
      name: "search",
    });
    expect(result).toEqual(reply);
  });

  test("tools.call omits arguments when none are given", async () => {
    const env = makeEnv();
    const inbox = connect(env);
    await inbox.take(2);

    const { sent } = await roundTrip(
      inbox,
      () => env.harbourmaster.tools.call("ping"),
      { content: [] }
    );
    const { params } = toolsCallRequestSchema.parse(sent);
    expect(params).toEqual({ name: "ping" });
    expect("arguments" in params).toBe(false);
  });

  test("storage.get defaults to viewer scope and unwraps the value", async () => {
    const env = makeEnv();
    const inbox = connect(env);
    await inbox.take(2);

    const { result, sent } = await roundTrip(
      inbox,
      () => env.harbourmaster.storage.get("draft"),
      { value: { step: 2 } }
    );
    expect(storageGetRequestSchema.parse(sent).params).toEqual({
      key: "draft",
      scope: "viewer",
    });
    expect(result).toEqual({ step: 2 });
  });

  test("storage.get with shared scope resolves null when nothing is stored", async () => {
    const env = makeEnv();
    const inbox = connect(env);
    await inbox.take(2);

    const { result, sent } = await roundTrip(
      inbox,
      () => env.harbourmaster.storage.get("board", "shared"),
      { value: null }
    );
    expect(storageGetRequestSchema.parse(sent).params).toEqual({
      key: "board",
      scope: "shared",
    });
    expect(result).toBeNull();
  });

  test("storage.set sends the value and resolves to undefined", async () => {
    const env = makeEnv();
    const inbox = connect(env);
    await inbox.take(2);

    const { result, sent } = await roundTrip(
      inbox,
      () => env.harbourmaster.storage.set("n", [1, "two"], "shared"),
      {}
    );
    expect(storageSetRequestSchema.parse(sent).params).toEqual({
      key: "n",
      scope: "shared",
      value: [1, "two"],
    });
    expect(result).toBeUndefined();
  });

  test("storage.delete sends storage/delete with the default scope", async () => {
    const env = makeEnv();
    const inbox = connect(env);
    await inbox.take(2);

    const { result, sent } = await roundTrip(
      inbox,
      () => env.harbourmaster.storage.delete("gone"),
      {}
    );
    expect(storageDeleteRequestSchema.parse(sent).params).toEqual({
      key: "gone",
      scope: "viewer",
    });
    expect(result).toBeUndefined();
  });

  test("storage.list omits prefix when undefined and resolves to the keys", async () => {
    const env = makeEnv();
    const inbox = connect(env);
    await inbox.take(2);

    const all = await roundTrip(inbox, () => env.harbourmaster.storage.list(), {
      keys: ["a", "b"],
    });
    const allParams = storageListRequestSchema.parse(all.sent).params;
    expect(allParams).toEqual({ scope: "viewer" });
    expect("prefix" in allParams).toBe(false);
    expect(all.result).toEqual(["a", "b"]);
  });

  test("storage.list sends the prefix and scope", async () => {
    const env = makeEnv();
    const inbox = connect(env);
    await inbox.take(2);

    const { result, sent } = await roundTrip(
      inbox,
      () => env.harbourmaster.storage.list("note:", "shared"),
      { keys: ["note:1"] }
    );
    expect(storageListRequestSchema.parse(sent).params).toEqual({
      prefix: "note:",
      scope: "shared",
    });
    expect(result).toEqual(["note:1"]);
  });

  test("sendMessage sends a user ui/message and resolves to undefined", async () => {
    const env = makeEnv();
    const inbox = connect(env);
    await inbox.take(2);

    const { result, sent } = await roundTrip(
      inbox,
      () => env.harbourmaster.sendMessage("hello"),
      {}
    );
    expect(uiMessageRequestSchema.parse(sent).params).toEqual({
      content: [{ text: "hello", type: "text" }],
      role: "user",
    });
    expect(result).toBeUndefined();
  });

  test("an error response rejects with its message and code", async () => {
    const env = makeEnv();
    const inbox = connect(env);
    await inbox.take(2);

    const pending = env.harbourmaster.tools.call("broken");
    const [, , sent] = await inbox.take(3);
    channels.at(0)?.port1.postMessage({
      error: { code: -32_602, message: "bad arguments" },
      id: (sent as { id: number }).id,
      jsonrpc: "2.0",
    });
    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("bad arguments");
    expect((error as Error & { code: number }).code).toBe(-32_602);
  });

  test("a call made before the handshake is sent once connected", async () => {
    const env = makeEnv();
    const pending = env.harbourmaster.storage.get("early", "shared");
    const inbox = connect(env);

    const [, , sent] = await inbox.take(3);
    expect(storageGetRequestSchema.parse(sent).params).toEqual({
      key: "early",
      scope: "shared",
    });
    respond((sent as { id: number }).id, { value: "later" });
    expect(await pending).toBe("later");
  });

  test("calls reject with not connected when the page was opened directly", async () => {
    const env = makeEnv({ framed: false });
    await expect(env.harbourmaster.tools.call("x")).rejects.toThrow(
      "not connected"
    );
    await expect(env.harbourmaster.storage.get("k")).rejects.toThrow(
      "not connected"
    );
    await expect(env.harbourmaster.sendMessage("hi")).rejects.toThrow(
      "not connected"
    );
    expect(Object.isFrozen(env.harbourmaster.tools)).toBe(true);
    expect(Object.isFrozen(env.harbourmaster.storage)).toBe(true);
  });
});
