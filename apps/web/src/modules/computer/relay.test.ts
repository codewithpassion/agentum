import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";

/**
 * The relay Durable Object: the one place a self-hosted daemon's WebSocket is
 * held, and the one place an agent's computer request turns into a frame on
 * it.
 *
 * What is worth testing here is everything that happens when the daemon
 * misbehaves: a container that stops mid-command, a second container
 * dialling in with the same token, a host that was never started at all. The
 * happy path is one round trip and is the least of it.
 */

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    protected env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  env: {},
}));

const { createDb } = await import("#/db/client");
const { createHost } = await import("./hosts");
const { computerHosts } = await import("./schema");
const { ComputerRelay } = await import("./relay");

const migrationsDir = new URL("../../../drizzle/", import.meta.url);

const createTestD1 = (): D1Database => {
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", migrationsDir), "utf8")
  ) as { entries: { tag: string }[] };

  const sqlite = new Database(":memory:");
  for (const entry of journal.entries) {
    const sql = readFileSync(
      new URL(`${entry.tag}.sql`, migrationsDir),
      "utf8"
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.exec(statement);
    }
  }

  return {
    batch: (statements: { all: () => Promise<unknown> }[]) =>
      Promise.all(statements.map((statement) => statement.all())),
    prepare: (query: string) => {
      const stmt = sqlite.query(query);
      return {
        bind: (...params: SQLQueryBindings[]) => ({
          all: () => Promise.resolve({ results: stmt.all(...params) }),
          raw: () => Promise.resolve(stmt.values(...params)),
          run: () => Promise.resolve(stmt.run(...params)),
        }),
      };
    },
  } as unknown as D1Database;
};

/** The in-memory stand-in for `ctx.storage`; only get and put are reached. */
const storage = () => {
  const values = new Map<string, unknown>();
  return {
    get: (key: string) => Promise.resolve(values.get(key)),
    put: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
};

interface FakeSocket {
  close: (code: number, reason: string) => void;
  closed: { code: number; reason: string } | null;
  send: (data: string) => void;
  sent: string[];
}

/** Lets a pending promise's `.then` chain and any `setTimeout(0)` run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const MINUTE_MS = 60_000;

let db: Db;

const seedHost = async (name: string): Promise<string> => {
  const { host } = await createHost(db, {} as Env, "workspace-1", {
    config: {},
    kind: "self_hosted",
    name,
  });
  return host.id;
};

const hostRow = async (id: string) => {
  const [host] = await db
    .select()
    .from(computerHosts)
    .where(eq(computerHosts.id, id));
  return host;
};

/**
 * A relay wired to the in-memory database, plus the two things the runtime
 * would otherwise supply: the socket registry `ctx.acceptWebSocket` writes to,
 * and the `WebSocketPair` its `fetch` builds. A socket that is closed leaves
 * the registry, which is how the real one stops delivering to it.
 */
const relayFor = (hostId: string) => {
  const store = storage();
  const sockets: FakeSocket[] = [];

  const makeSocket = (): FakeSocket => {
    const socket: FakeSocket = {
      close: (code, reason) => {
        socket.closed = { code, reason };
        const at = sockets.indexOf(socket);
        if (at >= 0) {
          sockets.splice(at, 1);
        }
      },
      closed: null,
      send: (data) => {
        socket.sent.push(data);
      },
      sent: [],
    };
    return socket;
  };

  const ctx = {
    acceptWebSocket: (socket: FakeSocket) => {
      sockets.push(socket);
    },
    getWebSockets: () => [...sockets],
    storage: store,
  } as unknown as DurableObjectState;
  const env = { DB: {} } as unknown as Env;

  const instance = new ComputerRelay(ctx, env);
  // The base class is module-mocked and the whole suite shares one registry, so
  // whose stand-in ran is not this file's to decide: both fields are set here,
  // and the `Db` too - the object would otherwise build one from the binding.
  Object.assign(instance, { ctx, database: db, env });

  const connect = async (): Promise<FakeSocket> => {
    const server = makeSocket();
    // A class, because biome rewrites a function expression into something
    // `new` cannot call - and the runtime global is a constructor.
    Object.assign(globalThis, {
      WebSocketPair: class {
        0 = makeSocket();
        1 = server;
      },
    });
    await instance.fetch(
      new Request(`https://relay/hosts/${hostId}`, {
        headers: { Upgrade: "websocket" },
      })
    );
    return server;
  };

  /**
   * What the runtime does when a container stops: the socket is already gone
   * from the registry by the time the handler runs.
   */
  const disconnect = async (socket: FakeSocket): Promise<void> => {
    const at = sockets.indexOf(socket);
    if (at >= 0) {
      sockets.splice(at, 1);
    }
    await instance.webSocketClose(socket as unknown as WebSocket);
  };

  const deliver = (socket: FakeSocket, message: unknown) =>
    instance.webSocketMessage(
      socket as unknown as WebSocket,
      JSON.stringify(message)
    );

  return { connect, deliver, disconnect, instance, sockets, store };
};

const frames = (socket: FakeSocket): Record<string, unknown>[] =>
  socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);

beforeEach(() => {
  db = createDb(createTestD1());
});

describe("ComputerRelay", () => {
  test("a hello marks the host ready and records that it was seen", async () => {
    const hostId = await seedHost("office-box");
    const relay = relayFor(hostId);
    const socket = await relay.connect();

    await relay.deliver(socket, {
      hostname: "office-box.local",
      type: "hello",
      version: "1.2.3",
    });

    const host = await hostRow(hostId);
    expect(host?.status).toBe("ready");
    expect(host?.lastSeenAt).toBeInstanceOf(Date);
    expect(await relay.instance.status()).toEqual({
      connected: true,
      hostname: "office-box.local",
      version: "1.2.3",
    });
  });

  test("a request goes out on the socket and resolves on the matching reply", async () => {
    const hostId = await seedHost("office-box");
    const relay = relayFor(hostId);
    const socket = await relay.connect();

    const pending = relay.instance.request({
      id: "req-1",
      op: "read",
      path: "/notes.md",
    });
    await flush();

    expect(frames(socket)).toEqual([
      { id: "req-1", op: "read", path: "/notes.md" },
    ]);

    const reply = { id: "req-1", result: { content: "hi", ok: true, size: 2 } };
    await relay.deliver(socket, reply);
    expect(await pending).toEqual(reply);
  });

  test("a request with no daemon fails at once, naming the host and when it was last seen", async () => {
    const hostId = await seedHost("office-box");
    await db
      .update(computerHosts)
      .set({ lastSeenAt: new Date(Date.now() - 12 * MINUTE_MS) })
      .where(eq(computerHosts.id, hostId));

    const relay = relayFor(hostId);
    // Nothing has connected, so the id is only in storage - where a relay that
    // was evicted and woken by a request would also find it.
    await relay.store.put("hostId", hostId);

    expect(
      relay.instance.request({ op: "read", path: "/notes.md" })
    ).rejects.toThrow(
      'The computer host "office-box" is offline (12 minutes ago). Start the container and try again.'
    );
  });

  test("a closed socket rejects what was pending and marks the host offline", async () => {
    const hostId = await seedHost("office-box");
    const relay = relayFor(hostId);
    const socket = await relay.connect();
    await relay.deliver(socket, { type: "hello", version: "1.2.3" });

    const pending = relay.instance.request({ id: "req-1", op: "exec" });
    await flush();
    await relay.disconnect(socket);

    await expect(pending).rejects.toThrow(
      "The connection to the computer closed before it answered."
    );
    const host = await hostRow(hostId);
    expect(host?.status).toBe("offline");
    expect((await relay.instance.status()).connected).toBe(false);
  });

  test("a second daemon replaces the first", async () => {
    const hostId = await seedHost("office-box");
    const relay = relayFor(hostId);
    const first = await relay.connect();
    const second = await relay.connect();

    expect(first.closed?.code).toBe(1012);
    expect(relay.sockets).toEqual([second]);

    const pending = relay.instance.request({ id: "req-1", op: "list" });
    await flush();
    expect(first.sent).toEqual([]);
    expect(frames(second)).toEqual([{ id: "req-1", op: "list" }]);

    await relay.deliver(second, {
      id: "req-1",
      result: { entries: [], ok: true },
    });
    await pending;
  });

  test("a heartbeat is acknowledged and touches last seen", async () => {
    const hostId = await seedHost("office-box");
    const relay = relayFor(hostId);
    const socket = await relay.connect();
    expect((await hostRow(hostId))?.lastSeenAt).toBeNull();

    await relay.deliver(socket, { type: "heartbeat" });

    expect(frames(socket)).toEqual([{ type: "heartbeat_ack" }]);
    expect((await hostRow(hostId))?.lastSeenAt).toBeInstanceOf(Date);
  });

  test("a second exec waits for the first to answer", async () => {
    const hostId = await seedHost("office-box");
    const relay = relayFor(hostId);
    const socket = await relay.connect();

    const first = relay.instance.request({
      command: "sleep 1",
      id: "exec-1",
      op: "exec",
    });
    const second = relay.instance.request({
      command: "echo hi",
      id: "exec-2",
      op: "exec",
    });
    await flush();

    expect(frames(socket).map((frame) => frame.id)).toEqual(["exec-1"]);

    const done = { exitCode: 0, ok: true, stderr: "", stdout: "" };
    await relay.deliver(socket, { id: "exec-1", result: done });
    await first;
    await flush();

    expect(frames(socket).map((frame) => frame.id)).toEqual([
      "exec-1",
      "exec-2",
    ]);
    await relay.deliver(socket, { id: "exec-2", result: done });
    await second;
  });
});
