import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConnectClient, socketUrl, startConnectClient } from "./connect";
import { createHandlers } from "./handlers";

const TOKEN = "host-token";
const POLL_MS = 10;
const WAIT_MS = 2000;

interface Relay {
  authorizations: string[];
  closeCurrent: () => void;
  connections: number;
  hellos: Record<string, unknown>[];
  replies: Record<string, unknown>[];
  request: (message: unknown) => void;
  server: Bun.Server<undefined>;
}

/** Stands in for Agentum's `/api/computer-hosts/connect` route. */
const startRelay = (): Relay => {
  const state = {
    authorizations: [] as string[],
    connections: 0,
    hellos: [] as Record<string, unknown>[],
    replies: [] as Record<string, unknown>[],
  };
  let current: Bun.ServerWebSocket<undefined> | null = null;

  const server = Bun.serve({
    fetch(request, self) {
      state.authorizations.push(request.headers.get("authorization") ?? "");
      if (self.upgrade(request)) {
        return;
      }
      return new Response("expected a websocket", { status: 426 });
    },
    port: 0,
    websocket: {
      close() {
        current = null;
      },
      message(_ws, raw) {
        const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
        if (parsed.type === "hello") {
          state.hellos.push(parsed);
          return;
        }
        if (parsed.type === "heartbeat") {
          return;
        }
        state.replies.push(parsed);
      },
      open(ws) {
        current = ws;
        state.connections += 1;
      },
    },
  });

  return {
    get authorizations() {
      return state.authorizations;
    },
    closeCurrent() {
      current?.close();
    },
    get connections() {
      return state.connections;
    },
    get hellos() {
      return state.hellos;
    },
    get replies() {
      return state.replies;
    },
    request(message: unknown) {
      current?.send(JSON.stringify(message));
    },
    server,
  };
};

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: polling is the point
    await Bun.sleep(POLL_MS);
  }
  throw new Error("timed out waiting for the relay");
};

let relay: Relay;
let client: ConnectClient | null = null;
let root = "";

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "computerd-connect-")));
  relay = startRelay();
});

afterEach(async () => {
  client?.stop();
  client = null;
  // Not awaited: `stop(true)` does not settle while a WebSocket is still being
  // torn down, and the test has no reason to wait for the socket's last frame.
  relay.server.stop(true);
  await rm(root, { force: true, recursive: true });
});

const start = () => {
  client = startConnectClient({
    // Short delays keep the reconnect assertion fast; production defaults are
    // 1 s to 60 s.
    baseDelayMs: 20,
    handle: createHandlers({ execMaxMs: 5000, root }),
    maxDelayMs: 100,
    token: TOKEN,
    url: `http://localhost:${relay.server.port}`,
  });
};

describe("socketUrl", () => {
  test("derives ws from http and wss from https", () => {
    expect(socketUrl("http://localhost:3720")).toBe(
      "ws://localhost:3720/api/computer-hosts/connect"
    );
    expect(socketUrl("https://agentum.example.com")).toBe(
      "wss://agentum.example.com/api/computer-hosts/connect"
    );
  });
});

describe("connect mode", () => {
  test("announces itself, answers requests and reconnects", async () => {
    start();

    await waitFor(() => relay.hellos.length === 1);
    expect(relay.hellos[0]).toEqual({
      hostname: expect.any(String),
      type: "hello",
      version: expect.any(String),
    });
    expect(relay.authorizations[0]).toBe(`Bearer ${TOKEN}`);

    relay.request({ id: "ping-1", op: "ping" });
    await waitFor(() => relay.replies.length === 1);
    const reply = relay.replies[0] as { id: string; result: { ok: boolean } };
    expect(reply.id).toBe("ping-1");
    expect(reply.result.ok).toBe(true);

    // A dropped socket is the normal case, not an error case: the daemon has to
    // come back on its own.
    relay.closeCurrent();
    await waitFor(() => relay.connections === 2);
    await waitFor(() => relay.hellos.length === 2);
  });

  test("ignores heartbeat acknowledgements", async () => {
    start();
    await waitFor(() => relay.hellos.length === 1);

    relay.request({ type: "heartbeat_ack" });
    relay.request({ id: "after-ack", op: "ping" });

    await waitFor(() => relay.replies.length === 1);
    expect((relay.replies[0] as { id: string }).id).toBe("after-ack");
  });

  test("stops reconnecting once it is stopped", async () => {
    start();
    await waitFor(() => relay.connections === 1);

    client?.stop();
    client = null;
    await Bun.sleep(300);
    expect(relay.connections).toBe(1);
  });
});
