// The live-dashboard fixture run end to end: the real page script
// (`BRIDGE_JS`) in a fake sandboxed window, the real frame bridge with the
// phase 2 handlers, and a real MessageChannel between them. Only the browser
// (window, document, iframe) and the backends (tRPC, share route) are fakes.

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { ArtifactStorageScope } from "@repo/protocol/artifacts";
import { BRIDGE_JS } from "../../server/artifact-content/bridge.ts";
import { createFrameBridge, type FrameBridge } from "./frame-bridge.ts";
import {
  createCallHandlers,
  type FrameCalls,
  LinkCallError,
  type MemberCalls,
} from "./frame-calls.ts";

const FIXTURE = await readFile(
  new URL(
    "../../server/artifact-content/fixtures/live-dashboard.html",
    import.meta.url
  ),
  "utf8"
);
const SCRIPT = FIXTURE.slice(
  FIXTURE.indexOf("<script>") + "<script>".length,
  FIXTURE.indexOf("</script>")
);

const NONCE = "frame-nonce-1";
const INIT = {
  theme: "light",
  version: { createdAt: "2026-10-27T00:00:00.000Z", number: 1 },
  viewer: "member",
} as const;

type Listener = (event: unknown) => void;

const bridges: FrameBridge[] = [];
afterEach(() => {
  for (const bridge of bridges.splice(0)) {
    bridge.dispose();
  }
});

/** In-memory app storage with the two areas, shared across page loads. */
const makeStore = (shared: Record<string, unknown> = {}) => {
  const areas: Record<ArtifactStorageScope, Map<string, unknown>> = {
    shared: new Map(Object.entries(shared)),
    viewer: new Map(),
  };
  const writes: string[] = [];
  const calls: MemberCalls = {
    callTool: ({ tool }) =>
      tool === "shop/list_orders"
        ? Promise.resolve({
            result: { orders: [{ id: 1 }, { id: 2 }, { id: 3 }] },
          })
        : Promise.reject(new Error("db password is hunter2")),
    storageDelete: ({ key, scope }) => {
      areas[scope].delete(key);
      return Promise.resolve({});
    },
    storageGet: ({ key, scope }) =>
      Promise.resolve({ value: areas[scope].get(key) ?? null }) as never,
    storageList: ({ prefix, scope }) =>
      Promise.resolve({
        keys: [...areas[scope].keys()].filter((key) =>
          key.startsWith(prefix ?? "")
        ),
      }),
    storageSet: ({ key, scope, value }) => {
      writes.push(`${scope}:${key}`);
      areas[scope].set(key, value);
      return Promise.resolve({});
    },
  };
  return { areas, calls, writes };
};

interface PageOptions {
  calls: FrameCalls;
  messages?: string[] | null;
  /** The iframe's `name`; the frame expects NONCE. */
  name?: string;
}

/** One iframe document running the fixture, wired to a frame bridge. */
const loadPage = (options: PageOptions) => {
  const { calls, name = NONCE, messages = null } = options;
  const text = new Map<string, string>();
  const elements = new Map<
    string,
    { onclick: (() => void) | null; textContent: string }
  >();
  const element = (id: string) => {
    let found = elements.get(id);
    if (!found) {
      found = { onclick: null, textContent: "" };
      Object.defineProperty(found, "textContent", {
        get: () => text.get(id) ?? "",
        set: (value: string) => {
          text.set(id, value);
        },
      });
      elements.set(id, found);
    }
    return found;
  };
  element("status").textContent = "Loading";

  const pageListeners: Listener[] = [];
  const graceTimers: (() => void)[] = [];
  let blanked = 0;
  const iframeWindow = {
    postMessage: (data: unknown, _origin: string, ports: unknown[]) => {
      queueMicrotask(() => {
        for (const listener of pageListeners) {
          listener({ data, ports, source: parent });
        }
      });
    },
  };
  const bridge = createFrameBridge({
    confirmOpenLink: () => false,
    extraHandlers: createCallHandlers({
      calls,
      onMessage: messages
        ? (message) => {
            messages.push(message);
          }
        : undefined,
    }),
    getInit: () => INIT,
    getTarget: () => iframeWindow,
    nonce: NONCE,
    onBlank: () => {
      blanked += 1;
    },
    openLink: () => undefined,
    setTimer: (fn) => {
      graceTimers.push(fn);
      return graceTimers.length;
    },
  });
  bridges.push(bridge);

  const parent = {
    postMessage: (data: unknown) => {
      queueMicrotask(() => {
        bridge.handleWindowMessage({ data, source: iframeWindow });
      });
    },
  };
  const win = {
    addEventListener: (type: string, listener: Listener) => {
      if (type === "message") {
        pageListeners.push(listener);
      }
    },
    name,
    parent,
  };
  const doc = {
    addEventListener: () => undefined,
    currentScript: { src: "http://x.test/a/ID/c/TOKEN/_hm/bridge.js" },
    documentElement: {
      getBoundingClientRect: () => ({ height: 10, width: 10 }),
    },
    getElementById: element,
  };
  // The retry loop is not needed: the first attempt is synchronous.
  const noTimer = () => 0;
  new Function("window", "document", "setTimeout", "clearTimeout", BRIDGE_JS)(
    win,
    doc,
    noTimer,
    noTimer
  );
  new Function("window", "document", SCRIPT)(win, doc);

  return {
    blanked: () => blanked,
    click: () => elements.get("ask")?.onclick?.(),
    /** The iframe `load` event, then the end of the 2 s grace period. */
    load: () => {
      bridge.handleLoad();
      for (const fn of graceTimers.splice(0)) {
        fn();
      }
    },
    settled: async () => {
      await waitFor(() => text.get("status") !== "Loading");
      return Object.fromEntries(text);
    },
    text: () => Object.fromEntries(text),
  };
};

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const waitFor = async (
  check: () => boolean,
  triesLeft = 200
): Promise<void> => {
  if (check() || triesLeft === 0) {
    return;
  }
  await pause(5);
  await waitFor(check, triesLeft - 1);
};

describe("live dashboard, signed-in member", () => {
  test("reads a tool, counts visits per viewer, shows the shared note", async () => {
    const store = makeStore({ note: "Ship on Friday" });
    const first = await loadPage({
      calls: { ...store.calls, viewer: "member" },
    }).settled();
    expect(first).toMatchObject({
      orders: "3 orders",
      status: "Live",
      "team-note": "Ship on Friday",
      visits: "Visit 1",
    });

    const second = await loadPage({
      calls: { ...store.calls, viewer: "member" },
    }).settled();
    expect(second.visits).toBe("Visit 2");
    expect(store.writes).toEqual(["viewer:visits", "viewer:visits"]);
    expect(store.areas.shared.size).toBe(1);
  });

  test("a failing backend shows a fixed message, never its own text", async () => {
    const store = makeStore();
    const calls: MemberCalls = {
      ...store.calls,
      callTool: () => Promise.reject(new Error("db password is hunter2")),
    };
    const page = await loadPage({
      calls: { ...calls, viewer: "member" },
    }).settled();
    expect(page.status).toBe("The call failed.");
    expect(JSON.stringify(page)).not.toContain("hunter2");
  });

  test("ui/message reaches the host, or is refused when the host takes none", async () => {
    const store = makeStore();
    const messages: string[] = [];
    const taking = loadPage({
      calls: { ...store.calls, viewer: "member" },
      messages,
    });
    await taking.settled();
    taking.click();
    await waitFor(() => messages.length > 0);
    expect(messages).toEqual(["Please refresh the orders"]);

    const refusing = loadPage({ calls: { ...store.calls, viewer: "member" } });
    await refusing.settled();
    refusing.click();
    await waitFor(() => refusing.text().status !== "Live");
    expect(refusing.text().status).toBe(
      "This viewer doesn't take messages from the artifact."
    );
  });
});

describe("live dashboard, share link", () => {
  test("a link reads the tool and the shared note, and the viewer area is refused", async () => {
    const page = await loadPage({
      calls: {
        callTool: () => Promise.resolve({ result: { orders: [{ id: 1 }] } }),
        storageGet: ({ key }) =>
          Promise.resolve({ value: key === "note" ? "Ship on Friday" : null }),
        storageList: () => Promise.resolve({ keys: [] }),
        viewer: "link",
      },
    }).settled();
    expect(page.orders).toBe("1 orders");
    expect(page["team-note"]).toBe("Ship on Friday");
    expect(page.status).toBe("Shared links can read only the shared area.");
    expect(page.visits).toBeUndefined();
  });

  test("a snapshot link's tool call is refused with the link's own message", async () => {
    const page = await loadPage({
      calls: {
        callTool: () => Promise.reject(new LinkCallError(403)),
        storageGet: () => Promise.resolve({ value: null }),
        storageList: () => Promise.resolve({ keys: [] }),
        viewer: "link",
      },
    }).settled();
    expect(page.status).toBe("This link doesn't allow that tool.");
    expect(page.orders).toBeUndefined();
  });
});

describe("live dashboard, nonce gate", () => {
  test("a page without the frame's nonce gets no port and the frame blanks", async () => {
    const store = makeStore();
    const pages = ["", "wrong", "other"].map((name) =>
      loadPage({ calls: { ...store.calls, viewer: "member" }, name })
    );
    await pause(20);
    for (const page of pages) {
      expect(page.text().status).toBe("Loading");
      page.load();
      expect(page.blanked()).toBe(1);
    }
    expect(store.writes).toHaveLength(0);
  });
});
