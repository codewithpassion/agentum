import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Db } from "#/db/client";

/**
 * The dispatcher: which backend an agent's computer resolves to, decided by
 * `agent.computer` alone. What proves the choice is which of the three fakes
 * below was called - the Durable Object, the relay, or the Fly transport.
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

beforeEach(async () => {
  const d1 = createTestD1();
  db = createDb(d1);
  execCalls = [];
  writeCalls = [];
  relayCalls = [];
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
          return Promise.reject(new Error(RELAY_OFFLINE));
        },
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

  test("a fly agent with a machine goes to the fly transport", async () => {
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

    // The transport's `fetch` is the global one when nothing injects it, so it
    // is replaced here: nothing in this suite may reach a network.
    const realFetch = globalThis.fetch;
    const calledWith: string[] = [];
    globalThis.fetch = ((url: string, init: RequestInit) => {
      calledWith.push(String(url));
      const message = JSON.parse(String(init.body)) as { id: string };
      return Promise.resolve(
        Response.json({
          id: message.id,
          result: { exitCode: 0, ok: true, stderr: "", stdout: "from fly" },
        })
      );
    }) as unknown as typeof fetch;

    try {
      const result = await (await createComputerClient(db, env, agent.id)).exec(
        "ls"
      );

      expect(execCalls).toEqual([]);
      expect(calledWith).toEqual(["https://agentum-computers.fly.dev/op"]);
      expect(result).toEqual({
        exitCode: 0,
        ok: true,
        stderr: "",
        stdout: "from fly",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
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
