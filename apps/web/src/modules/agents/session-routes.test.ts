import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { ApiEnv } from "#/api/types";
import type { Db } from "#/db/client";
import type { SessionStatus } from "#/modules/anthropic/events";
import type { ListedSession } from "#/modules/anthropic/gateway";

/**
 * The owner's session history routes. Anthropic is a stubbed `fetch`, so the
 * real gateway runs; the router is a fake binding that records the switch.
 */

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

const ADA_ID = "user_2aAdaAAAAAAAAAAAAAAAAAAA";
const BOB_ID = "user_2bBobBBBBBBBBBBBBBBBBBBB";

const { createDb } = await import("#/db/client");
const { addMember, createWorkspace } = await import(
  "#/modules/workspaces/service"
);
const { createAgentSessionRoutes } = await import("./session-routes");
const { createAgent, setAgentRegistration } = await import("./service");
const { listAgentSessionRows, recordSessionEnd, recordSessionStart } =
  await import("./session-history");

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

let db: Db;
let env: Env;
let workspaceId: string;
let agentId: string;
let switched: {
  agentId: string;
  model: string | null;
  sessionId: string;
  status: string;
}[];

/** What Anthropic says about each session, by id. */
let anthropicStatus: Record<string, SessionStatus>;
let listed: ListedSession[];
let role: "member" | "owner";

const gateway = {
  getSession: (id: string) => {
    const status = anthropicStatus[id];
    return status ? Promise.resolve(status) : Promise.reject(new Error("404"));
  },
  listSessions: () => Promise.resolve(listed),
};

const request = (path: string, init: { method?: string } = {}) => {
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    c.set("workspace", { id: workspaceId } as never);
    c.set("member", { role } as never);
    await next();
  });
  app.route(
    "/agents",
    createAgentSessionRoutes(() => Promise.resolve(gateway))
  );
  return app.request(path, { method: init.method ?? "GET" }, env);
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const rows = () => listAgentSessionRows(db, workspaceId, agentId, 20);

const seedSession = async (sessionId: string, endReason?: "reset") => {
  await recordSessionStart(db, {
    agentId,
    anthropicSessionId: sessionId,
    model: "claude-opus-5-5",
    title: sessionId,
    workspaceId,
  });
  if (endReason) {
    await recordSessionEnd(db, sessionId, endReason);
  }
};

beforeEach(async () => {
  const d1 = createTestD1();
  db = createDb(d1);
  switched = [];
  anthropicStatus = {};
  listed = [];
  env = {
    AGENT_ROUTER: {
      get: () => ({
        retireSession: () => Promise.resolve({ retired: true }),
        switchSession: (
          id: string,
          target: { model: string | null; sessionId: string; status: string }
        ) => {
          switched.push({ agentId: id, ...target });
          return Promise.resolve();
        },
      }),
      idFromName: (name: string) => name,
    },
    ANTHROPIC_API_KEY: "sk-test",
    DB: d1,
  } as unknown as Env;
  const { workspace } = await createWorkspace(db, {
    name: "Alpha",
    owner: {
      clerkUserId: ADA_ID,
      email: "ada@example.com",
      imageUrl: null,
      name: "Ada Lovelace",
    },
  });
  workspaceId = workspace.id;
  await addMember(db, workspaceId, {
    clerkUserId: BOB_ID,
    email: "bob@example.com",
    imageUrl: null,
    name: "Bob Barker",
    role: "member",
  });
  const { agent } = await createAgent(db, workspaceId, {
    instructions: "",
    name: "Researcher",
    soul: "",
  });
  agentId = agent.id;
  await setAgentRegistration(db, agentId, {
    anthropicAgentId: "agt_1",
    memoryStoreId: null,
  });
  role = "owner";
});

describe("GET /agents/:id/sessions", () => {
  test("lists the history newest first and marks the current session", async () => {
    await seedSession("sesn_a", "reset");
    await tick();
    await seedSession("sesn_b");

    const response = await request(`/agents/${agentId}/sessions`);
    const body = (await response.json()) as {
      sessions: { current: boolean; endReason: string | null; id: string }[];
    };

    expect(response.status).toBe(200);
    expect(body.sessions.map((s) => [s.id, s.current, s.endReason])).toEqual([
      ["sesn_b", true, null],
      ["sesn_a", false, "reset"],
    ]);
  });

  test("imports the sessions Anthropic already holds when there is no history", async () => {
    listed = [
      {
        createdAt: "2026-10-01T10:00:00Z",
        id: "sesn_old",
        title: "Researcher in general",
        updatedAt: "2026-10-01T11:00:00Z",
      },
    ];

    const response = await request(`/agents/${agentId}/sessions`);
    const body = (await response.json()) as {
      sessions: { current: boolean; endReason: string | null; id: string }[];
    };

    expect(body.sessions).toMatchObject([
      { current: false, endReason: "imported", id: "sesn_old" },
    ]);
  });

  test("is owner-only", async () => {
    role = "member";
    const response = await request(`/agents/${agentId}/sessions`);

    expect(response.status).toBe(403);
  });
});

describe("POST /agents/:id/sessions/:sessionId/resume", () => {
  test("switches the router to a session Anthropic still runs", async () => {
    await seedSession("sesn_a", "reset");
    anthropicStatus.sesn_a = "idle";

    const response = await request(
      `/agents/${agentId}/sessions/sesn_a/resume`,
      { method: "POST" }
    );

    expect(response.status).toBe(200);
    expect(switched).toEqual([
      {
        agentId,
        model: "claude-opus-5-5",
        sessionId: "sesn_a",
        status: "idle",
      },
    ]);
  });

  test("refuses a session Anthropic has terminated", async () => {
    await seedSession("sesn_a", "reset");
    anthropicStatus.sesn_a = "terminated";

    const response = await request(
      `/agents/${agentId}/sessions/sesn_a/resume`,
      { method: "POST" }
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(409);
    expect(body.error).toBe("This session can't be resumed.");
    expect(switched).toEqual([]);
    expect((await rows())[0]?.endReason).toBe("reset");
  });

  test("refuses a session Anthropic no longer knows", async () => {
    await seedSession("sesn_a", "reset");

    const response = await request(
      `/agents/${agentId}/sessions/sesn_a/resume`,
      { method: "POST" }
    );

    expect(response.status).toBe(409);
    expect(switched).toEqual([]);
  });

  test("is owner-only", async () => {
    await seedSession("sesn_a", "reset");
    anthropicStatus.sesn_a = "idle";
    role = "member";

    const response = await request(
      `/agents/${agentId}/sessions/sesn_a/resume`,
      { method: "POST" }
    );

    expect(response.status).toBe(403);
    expect(switched).toEqual([]);
  });

  test("knows no session the agent never had", async () => {
    anthropicStatus.sesn_x = "idle";

    const response = await request(
      `/agents/${agentId}/sessions/sesn_x/resume`,
      { method: "POST" }
    );

    expect(response.status).toBe(404);
  });
});
