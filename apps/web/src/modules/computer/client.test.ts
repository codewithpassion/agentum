import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Db } from "#/db/client";
import type { FlyGateway } from "./fly-gateway";

/**
 * The dispatcher: which backend an agent's computer resolves to, decided by
 * `agent.computer` alone. What proves the choice is which fake
 * below was called - the Durable Object or the relay.
 */

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

const { createDb } = await import("#/db/client");
const { generateConnectorKey } = await import("#/crypto");
const { createAgent } = await import("#/modules/agents/service");
const { createWorkspace } = await import("#/modules/workspaces/service");
const { createHost } = await import("./hosts");
const { createComputerClient } = await import("./client");

const migrationsDir = new URL("../../../drizzle/", import.meta.url);

const createTestD1 = (): D1Database => {
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", migrationsDir), "utf8")
  ) as { entries: { tag: string }[] };

  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
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

const NO_SUCH_AGENT = /No agent/;

/** What the relay says when the host's container is not connected. */
const RELAY_OFFLINE =
  'The computer host "office-box" is offline (never connected). Start the container and try again.';

let db: Db;
let env: Env;
let workspaceId: string;
let execCalls: string[];
let writeCalls: { content: string | Uint8Array; path: string }[];
let relayCalls: Record<string, unknown>[];
/** Whether the relay reports the client as connected; tests flip it. */
let relayConnected: () => boolean;
let relayOnline: boolean;

beforeEach(async () => {
  const d1 = createTestD1();
  db = createDb(d1);
  execCalls = [];
  writeCalls = [];
  relayCalls = [];
  relayOnline = false;
  relayConnected = () => relayOnline;
  env = {
    AGENT_COMPUTER: {
      get: () => ({
        exec: (command: string) => {
          execCalls.push(command);
          return Promise.resolve({
            exitCode: 0,
            ok: true,
            stderr: "",
            stdout: "from the durable object",
          });
        },
        writeFile: (path: string, content: string | Uint8Array) => {
          writeCalls.push({ content, path });
          return Promise.resolve({ created: true, ok: true, size: 4 });
        },
      }),
      idFromName: (name: string) => name,
    },
    // The relay Durable Object, which a self-hosted agent's every operation
    // goes through; here it answers the way it does for a stopped container.
    COMPUTER_RELAY: {
      get: () => ({
        request: (message: Record<string, unknown>) => {
          relayCalls.push(message);
          if (relayConnected()) {
            return Promise.resolve({
              ok: true,
              result_json: JSON.stringify({
                bytes_total: 2,
                duration_ms: 1,
                exit_code: 0,
                stderr: "",
                stdout: "hi",
                truncated: false,
              }),
            });
          }
          return Promise.reject(new Error(RELAY_OFFLINE));
        },
        status: () =>
          Promise.resolve({
            capabilities: null,
            connected: relayConnected(),
            hostname: null,
            version: null,
            workdir: "/var/lib/agentum-computer/sessions",
          }),
      }),
      idFromName: (name: string) => name,
    },
    CONNECTOR_KEY: generateConnectorKey(),
    DB: d1,
  } as unknown as Env;

  const workspace = await createWorkspace(db, {
    name: "Alpha",
    owner: {
      clerkUserId: "user_2aAdaAAAAAAAAAAAAAAAAAAA",
      email: "ada@example.com",
      imageUrl: null,
      name: "Ada Lovelace",
    },
  });
  workspaceId = workspace.workspace.id;
});

const newAgent = async (
  input: {
    computer?: "cloudflare" | "fly" | "self_hosted";
    hostId?: string;
  } = {}
) => {
  const { agent } = await createAgent(db, workspaceId, {
    computer: input.computer,
    computerHostId: input.hostId,
    instructions: "",
    name: `Agent-${crypto.randomUUID().slice(0, 8)}`,
    soul: "",
  });
  return agent;
};

describe("createComputerClient", () => {
  test("a cloudflare agent runs on its Durable Object", async () => {
    const agent = await newAgent();

    const computer = await createComputerClient(db, env, agent.id);
    const result = await computer.exec("echo hi");

    expect(execCalls).toEqual(["echo hi"]);
    expect(result).toEqual({
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: "from the durable object",
    });
  });

  test("a self-hosted agent goes to the relay, not the Durable Object", async () => {
    const { host } = await createHost(db, env, workspaceId, {
      config: {},
      kind: "self_hosted",
      name: "office-box",
    });
    const agent = await newAgent({ computer: "self_hosted", hostId: host.id });

    const result = await (await createComputerClient(db, env, agent.id)).exec(
      "ls"
    );

    expect(execCalls).toEqual([]);
    // The relay was asked, and its reason - the one a person can act on -
    // reached the agent verbatim rather than being replaced with a generic one.
    expect(relayCalls.map((message) => message.op)).toEqual(["exec"]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe(RELAY_OFFLINE);
  });

  describe("a fly agent", () => {
    let started: string[];
    let connectAfterStart: boolean;
    let sleeps: number;

    const flyAgent = async () => {
      const { host } = await createHost(db, env, workspaceId, {
        config: { app: "agentum-computers" },
        flyApiToken: "fly_api_token",
        kind: "fly",
        name: "fly-eu",
      });
      const agent = await newAgent({ computer: "fly", hostId: host.id });
      await db.run(
        `update agents set computer_ref = '{"machineId":"m-1"}' where id = '${agent.id}'`
      );
      return agent;
    };

    const clientFor = (agentId: string, timeoutMs = 45_000) =>
      createComputerClient(db, env, agentId, {
        createFlyGateway: () =>
          ({
            startMachine: (_app: string, id: string) => {
              started.push(id);
              return Promise.resolve();
            },
          }) as unknown as FlyGateway,
        wake: {
          pollMs: 1000,
          sleep: () => {
            sleeps += 1;
            // The client dials in a few polls after the machine boots.
            if (sleeps === 3 && connectAfterStart) {
              relayOnline = true;
            }
            return Promise.resolve();
          },
          timeoutMs,
        },
      });

    beforeEach(() => {
      started = [];
      connectAfterStart = true;
      sleeps = 0;
    });

    test("goes through the relay, never Fly's HTTP proxy", async () => {
      relayOnline = true;
      const realFetch = globalThis.fetch;
      let fetched = 0;
      globalThis.fetch = (() => {
        fetched += 1;
        return Promise.reject(new Error("no network in tests"));
      }) as unknown as typeof fetch;
      try {
        const agent = await flyAgent();
        const result = await (await clientFor(agent.id)).exec("ls");

        expect(result.ok).toBe(true);
        expect(execCalls).toEqual([]);
        expect(fetched).toBe(0);
        expect(relayCalls.map((message) => message.op)).toContain("exec");
        // Already connected: nothing to wake.
        expect(started).toEqual([]);
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    test("starts a machine whose client is not connected, waits for it, then sends", async () => {
      const agent = await flyAgent();

      const result = await (await clientFor(agent.id)).exec("ls");

      expect(started).toEqual(["m-1"]);
      expect(sleeps).toBe(3);
      expect(result.ok).toBe(true);
      expect(result.ok && result.stdout).toBe("hi");
      expect(relayCalls.map((message) => message.op)).toContain("exec");
    });

    test("tells the agent when the machine never connects, and sends nothing", async () => {
      connectAfterStart = false;
      const agent = await flyAgent();

      const result = await (await clientFor(agent.id, 5000)).exec("ls");

      expect(started).toEqual(["m-1"]);
      expect(sleeps).toBe(5);
      expect(relayCalls).toEqual([]);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toContain(
        "did not come online within 5 seconds"
      );
    });

    test("a start Fly refuses is named in the timeout, not thrown", async () => {
      connectAfterStart = false;
      const agent = await flyAgent();
      const client = await createComputerClient(db, env, agent.id, {
        createFlyGateway: () =>
          ({
            startMachine: () => Promise.reject(new Error("machine is gone")),
          }) as unknown as FlyGateway,
        wake: { pollMs: 1000, sleep: () => Promise.resolve(), timeoutMs: 2000 },
      });

      const result = await client.exec("ls");

      expect(result.ok === false && result.reason).toContain(
        "starting it failed: machine is gone"
      );
    });
  });

  test("a fly agent with no machine yet says so, rather than failing obscurely", async () => {
    const { host } = await createHost(db, env, workspaceId, {
      config: { app: "agentum-computers" },
      flyApiToken: "fly_api_token",
      kind: "fly",
      name: "fly-eu",
    });
    const agent = await newAgent({ computer: "fly", hostId: host.id });

    const result = await (
      await createComputerClient(db, env, agent.id)
    ).readFile("/a.txt");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("No machine");
  });

  test("a remote agent whose host was removed refuses with a reason", async () => {
    const { host } = await createHost(db, env, workspaceId, {
      config: {},
      kind: "self_hosted",
      name: "gone",
    });
    const agent = await newAgent({ computer: "self_hosted", hostId: host.id });
    await db.run(`delete from computer_hosts where id = '${host.id}'`);

    const result = await (
      await createComputerClient(db, env, agent.id)
    ).listDir("/");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(
      "computer host no longer exists"
    );
  });

  test("an upload to a cloudflare agent reaches the Durable Object as bytes", async () => {
    const agent = await newAgent();
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const result = await (
      await createComputerClient(db, env, agent.id)
    ).writeFileBytes("/uploads/logo.png", bytes);

    expect(result.ok).toBe(true);
    expect(writeCalls).toEqual([{ content: bytes, path: "/uploads/logo.png" }]);
  });

  test("an upload outside the computer's root is refused before any backend", async () => {
    const agent = await newAgent();

    const result = await (
      await createComputerClient(db, env, agent.id)
    ).writeFileBytes("../escape.png", new Uint8Array([1]));

    expect(result.ok).toBe(false);
    expect(writeCalls).toEqual([]);
  });

  test("an agent id that resolves to nothing throws", async () => {
    await expect(createComputerClient(db, env, "not-an-agent")).rejects.toThrow(
      NO_SUCH_AGENT
    );
  });
});
