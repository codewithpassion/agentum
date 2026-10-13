import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";

/**
 * The relay Durable Object: the one place a self-hosted daemon's WebSocket is
 * held, and the one place a computer request turns into a frame on it. These
 * tests cover what happens when the daemon misbehaves: a second connection, a
 * revoke, a reply that carries an error, a request that never gets an answer.
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

/** The in-memory stand-in for `ctx.storage`. */
const storage = () => {
  const values = new Map<string, unknown>();
  return {
    delete: (key: string) => {
      values.delete(key);
      return Promise.resolve(true);
    },
    get: (key: string) => Promise.resolve(values.get(key)),
    put: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
    setAlarm: () => Promise.resolve(),
  };
};

interface FakeSocket {
  attachment: unknown;
  close: (code: number, reason: string) => void;
  closed: { code: number; reason: string } | null;
  deserializeAttachment: () => unknown;
  heartbeat: Date | null;
  send: (data: string) => void;
  sent: string[];
  serializeAttachment: (value: unknown) => void;
}

const realSetTimeout = globalThis.setTimeout;
/** Timers the relay starts. Tests fire them by hand, so a deadline never has to pass in real time. */
interface FakeTimer {
  cleared: boolean;
  readonly fn: () => void;
  readonly ms: number;
  readonly repeat: boolean;
}
let timers: FakeTimer[] = [];

const installFakeTimers = () => {
  timers = [];
  Object.assign(globalThis, {
    clearInterval: (handle: FakeTimer) => {
      handle.cleared = true;
    },
    clearTimeout: (handle: FakeTimer) => {
      handle.cleared = true;
    },
    setInterval: (fn: () => void, ms: number) => {
      const timer: FakeTimer = { cleared: false, fn, ms, repeat: true };
      timers.push(timer);
      return timer;
    },
    setTimeout: (fn: () => void, ms: number) => {
      const timer: FakeTimer = { cleared: false, fn, ms, repeat: false };
      timers.push(timer);
      return timer;
    },
  });
};

/** Runs every live timer of the given length. A request's deadline is its timeout plus the grace. */
const fireTimers = (ms: number, repeat: boolean) => {
  for (const timer of timers) {
    if (!timer.cleared && timer.ms === ms && timer.repeat === repeat) {
      timer.fn();
    }
  }
};

/** Lets a pending promise's `.then` chain run. */
const flush = () => new Promise((resolve) => realSetTimeout(resolve, 0));

const DEADLINE_GRACE_MS = 10_000;
const UUID_PATTERN = /^[0-9a-f-]{36}$/;
const POLL_MS = 2000;

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

const HELLO = {
  arch: "amd64",
  capabilities: {
    desktop: false,
    desktop_unavailable_reason: null,
    git: true,
    python3: true,
    skills: false,
  },
  hostname: "office-box",
  os: "linux",
  protocol_version: 1,
  run_as_user: "agentum",
  type: "hello",
  version: "1.2.3",
  workdir: "/var/lib/agentum-computer/sessions",
};

/**
 * A relay wired to the in-memory database, plus the runtime pieces it would
 * otherwise get from Cloudflare: the socket registry, the attachment store and
 * the heartbeat stamps the platform keeps for each socket.
 */
const relayFor = (hostId: string) => {
  const store = storage();
  const sockets: FakeSocket[] = [];
  const background: Promise<unknown>[] = [];

  const makeSocket = (): FakeSocket => {
    const socket: FakeSocket = {
      attachment: null,
      close: (code, reason) => {
        socket.closed = { code, reason };
        const at = sockets.indexOf(socket);
        if (at >= 0) {
          sockets.splice(at, 1);
        }
      },
      closed: null,
      deserializeAttachment: () => socket.attachment,
      heartbeat: null,
      send: (data) => {
        socket.sent.push(data);
      },
      sent: [],
      serializeAttachment: (value) => {
        socket.attachment = value;
      },
    };
    return socket;
  };

  const ctx = {
    acceptWebSocket: (socket: FakeSocket) => {
      sockets.push(socket);
    },
    getWebSocketAutoResponseTimestamp: (socket: FakeSocket) => socket.heartbeat,
    getWebSockets: () => [...sockets],
    setWebSocketAutoResponse: () => undefined,
    storage: store,
    waitUntil: (promise: Promise<unknown>) => {
      background.push(promise);
    },
  } as unknown as DurableObjectState;
  const env = { DB: {} } as unknown as Env;

  const instance = new ComputerRelay(ctx, env);
  // The base class is module-mocked, so the instance is given its context and
  // database the way the runtime would have.
  Object.assign(instance, { ctx, database: db, env });

  const connect = async (): Promise<FakeSocket> => {
    const server = makeSocket();
    const client = makeSocket();
    // A class, because the runtime global is a constructor.
    Object.assign(globalThis, {
      WebSocketPair: class {
        0 = client;
        1 = server;
      },
      WebSocketRequestResponsePair: class {},
    });
    await instance.fetch(
      new Request(`https://relay/hosts/${hostId}`, {
        headers: { Upgrade: "websocket" },
      })
    );
    await flush();
    return server;
  };

  /** What the runtime does when a container stops: the socket is gone from the registry first. */
  const disconnect = async (socket: FakeSocket): Promise<void> => {
    const at = sockets.indexOf(socket);
    if (at >= 0) {
      sockets.splice(at, 1);
    }
    await instance.webSocketClose(socket as unknown as WebSocket);
    await Promise.all(background);
  };

  const deliver = (socket: FakeSocket, message: unknown) =>
    instance.webSocketMessage(
      socket as unknown as WebSocket,
      JSON.stringify(message)
    );

  return { background, connect, deliver, disconnect, instance };
};

const frames = (socket: FakeSocket): Record<string, unknown>[] =>
  socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);

beforeEach(() => {
  db = createDb(createTestD1());
  installFakeTimers();
});

afterEach(() => {
  Object.assign(globalThis, { setTimeout: realSetTimeout });
});

describe("ComputerRelay hello", () => {
  test("a hello marks the host ready and records what it reported", async () => {
    const hostId = await seedHost("office");
    const relay = relayFor(hostId);
    const socket = await relay.connect();

    await relay.deliver(socket, HELLO);
    await flush();

    const row = await hostRow(hostId);
    expect(row?.status).toBe("ready");
    expect(row?.os).toBe("linux");
    expect(row?.arch).toBe("amd64");
    expect(row?.protocolVersion).toBe(1);
    expect(row?.lastSeenAt).toBeInstanceOf(Date);
  });

  test("status reports the stored hello and the connection", async () => {
    const hostId = await seedHost("office");
    const relay = relayFor(hostId);
    const socket = await relay.connect();
    await relay.deliver(socket, HELLO);

    expect(await relay.instance.status()).toEqual({
      capabilities: HELLO.capabilities,
      connected: true,
      hostname: "office-box",
      version: "1.2.3",
      workdir: HELLO.workdir,
    });
  });

  test("a hello that cannot be read closes the socket with 4400", async () => {
    const hostId = await seedHost("office");
    const relay = relayFor(hostId);
    const socket = await relay.connect();

    await relay.deliver(socket, { ...HELLO, protocol_version: 2 });

    expect(socket.closed?.code).toBe(4400);
    expect((await relay.instance.status()).workdir).toBeNull();
  });

  test("a dropped last socket marks the host offline", async () => {
    const hostId = await seedHost("office");
    const relay = relayFor(hostId);
    const socket = await relay.connect();
    await relay.deliver(socket, HELLO);

    await relay.disconnect(socket);

    expect((await hostRow(hostId))?.status).toBe("offline");
    expect((await relay.instance.status()).connected).toBe(false);
  });
});

describe("ComputerRelay requests", () => {
  test("a request is answered with the reply carrying its id", async () => {
    const hostId = await seedHost("office");
    const relay = relayFor(hostId);
    const socket = await relay.connect();

    const outcome = relay.instance.request({ op: "file_get", path: "/a" });
    await flush();
    const [sent] = frames(socket);
    expect(sent?.op).toBe("file_get");
    expect(typeof sent?.id).toBe("string");

    await relay.deliver(socket, {
      id: sent?.id,
      result: { data_b64: "", eof: true, sha256: null, size: 0 },
    });

    const settled = await outcome;
    expect(settled).toMatchObject({ ok: true, reason: null });
    expect(JSON.parse(String(settled.result_json))).toEqual({
      data_b64: "",
      eof: true,
      sha256: null,
      size: 0,
    });
  });

  test("replies are matched by id, whatever order they arrive in", async () => {
    const hostId = await seedHost("office");
    const relay = relayFor(hostId);
    const socket = await relay.connect();

    const first = relay.instance.request({
      id: "one",
      op: "file_get",
      path: "/a",
    });
    const second = relay.instance.request({
      id: "two",
      op: "file_get",
      path: "/b",
    });
    await flush();
    await relay.deliver(socket, { id: "two", result: { marker: "second" } });
    await relay.deliver(socket, { id: "one", result: { marker: "first" } });

    expect((await second).result_json).toBe('{"marker":"second"}');
    expect((await first).result_json).toBe('{"marker":"first"}');
  });

  test("a request with no id gets a random one, registered before the send", async () => {
    const hostId = await seedHost("office");
    const relay = relayFor(hostId);
    const socket = await relay.connect();

    const outcome = relay.instance.request({
      op: "desktop_screenshot",
      quality: null,
    });
    await flush();
    const [sent] = frames(socket);
    const id = String(sent?.id);
    expect(id).toMatch(UUID_PATTERN);

    await relay.deliver(socket, { id, result: { ok: true } });
    expect((await outcome).ok).toBe(true);
  });

  test("a request with no socket fails offline and says when the host was last seen", async () => {
    const hostId = await seedHost("office");
    const relay = relayFor(hostId);

    const outcome = await relay.instance.request({
      op: "file_get",
      path: "/a",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("offline");
    expect(outcome.message).toContain("never connected");
  });

  test("a daemon's error reply keeps its own code", async () => {
    const hostId = await seedHost("office");
    const relay = relayFor(hostId);
    const socket = await relay.connect();

    const outcome = relay.instance.request({
      id: "missing",
      op: "file_get",
      path: "/x",
    });
    await flush();
    await relay.deliver(socket, {
      error: { code: "not_found", message: "no such file: /x" },
      id: "missing",
    });

    expect(await outcome).toEqual({
      code: "not_found",
      message: "no such file: /x",
      ok: false,
      reason: "client_error",
      result_json: null,
    });
  });

  test("a request with no answer times out at its deadline", async () => {
    const hostId = await seedHost("office");
    const relay = relayFor(hostId);
    await relay.connect();

    const outcome = relay.instance.request({
      id: "slow",
      op: "exec",
      timeout_ms: 1000,
    });
    await flush();
    fireTimers(1000 + DEADLINE_GRACE_MS, false);

    expect(await outcome).toMatchObject({ ok: false, reason: "timeout" });
  });

  test("a socket whose heartbeat went stale fails its request and is closed 4408", async () => {
    const hostId = await seedHost("office");
    const relay = relayFor(hostId);
    const socket = await relay.connect();
    socket.heartbeat = new Date(Date.now() - 60_000);

    const outcome = relay.instance.request({
      id: "quiet",
      op: "file_get",
      path: "/a",
    });
    await flush();
    fireTimers(POLL_MS, true);

    expect(await outcome).toMatchObject({ ok: false, reason: "stale" });
    expect(socket.closed?.code).toBe(4408);
  });

  test("desktop ops pass through to the daemon unchanged", async () => {
    const hostId = await seedHost("office");
    const relay = relayFor(hostId);
    const socket = await relay.connect();

    relay.instance.request({ id: "d1", op: "desktop_clipboard_get" });
    await flush();

    expect(frames(socket)).toEqual([{ id: "d1", op: "desktop_clipboard_get" }]);
  });

  test("execs run one at a time", async () => {
    const hostId = await seedHost("office");
    const relay = relayFor(hostId);
    const socket = await relay.connect();

    relay.instance.request({
      command: "a",
      id: "e1",
      op: "exec",
      timeout_ms: 1000,
    });
    relay.instance.request({
      command: "b",
      id: "e2",
      op: "exec",
      timeout_ms: 1000,
    });
    await flush();

    expect(frames(socket).map((frame) => frame.id)).toEqual(["e1"]);
  });
});

describe("ComputerRelay connections", () => {
  test("a newer connection replaces the old one with 4409", async () => {
    const hostId = await seedHost("office");
    const relay = relayFor(hostId);
    const first = await relay.connect();
    await relay.deliver(first, HELLO);

    const second = await relay.connect();

    expect(first.closed?.code).toBe(4409);
    expect(second.closed).toBeNull();
  });

  test("a request in flight on the replaced socket fails as replaced", async () => {
    const hostId = await seedHost("office");
    const relay = relayFor(hostId);
    const first = await relay.connect();

    const outcome = relay.instance.request({
      id: "held",
      op: "file_get",
      path: "/a",
    });
    await flush();
    await relay.connect();

    expect(await outcome).toMatchObject({ ok: false, reason: "replaced" });
    expect(first.closed?.code).toBe(4409);
  });

  test("a command whose caller was lost is cancelled when the machine returns", async () => {
    const hostId = await seedHost("office");
    const relay = relayFor(hostId);
    const socket = await relay.connect();

    relay.instance.request({
      command: "sleep 9",
      id: "orphan",
      op: "exec",
      timeout_ms: 1000,
    });
    await flush();
    await relay.disconnect(socket);
    const back = await relay.connect();

    expect(frames(back)).toEqual([
      expect.objectContaining({ op: "cancel", target_id: "orphan" }),
    ]);
  });

  test("revoke closes the socket with 4401 and fails what is in flight", async () => {
    const hostId = await seedHost("office");
    const relay = relayFor(hostId);
    const socket = await relay.connect();

    const outcome = relay.instance.request({
      id: "held",
      op: "file_get",
      path: "/a",
    });
    await flush();
    relay.instance.revoke();

    expect(socket.closed?.code).toBe(4401);
    expect(await outcome).toMatchObject({ ok: false, reason: "revoked" });
  });
});
